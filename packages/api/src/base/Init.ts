// Copyright 2017-2020 @polkadot/api authors & contributors
// This software may be modified and distributed under the terms
// of the Apache-2.0 license. See the LICENSE file for details.

import { SignedBlock, RuntimeVersion } from '@polkadot/types/interfaces';
import { ApiBase, ApiOptions, ApiTypes, DecorateMethod } from '../types';

import { Observable, Subscription, of } from 'rxjs';
import { map, switchMap } from 'rxjs/operators';
import { Metadata, Text } from '@polkadot/types';
import { LATEST_EXTRINSIC_VERSION } from '@polkadot/types/extrinsic/Extrinsic';
import { getMetadataTypes, getSpecTypes } from '@polkadot/types-known';
import { logger } from '@polkadot/util';
import { cryptoWaitReady } from '@polkadot/util-crypto';

import Decorate from './Decorate';

const KEEPALIVE_INTERVAL = 15000;

const l = logger('api/init');

export default abstract class Init<ApiType extends ApiTypes> extends Decorate<ApiType> {
  #healthTimer: NodeJS.Timeout | null = null;

  #updateSub?: Subscription;

  constructor (options: ApiOptions, type: ApiTypes, decorateMethod: DecorateMethod<ApiType>) {
    super(options, type, decorateMethod);

    if (!this.hasSubscriptions) {
      l.warn('Api will be available in a limited mode since the provider does not support subscriptions');
    }

    // all injected types added to the registry for overrides
    this.registry.setKnownTypes({
      types: options.types,
      typesAlias: options.typesAlias,
      typesChain: options.typesChain,
      typesSpec: options.typesSpec
    });

    // We only register the types (global) if this is not a cloned instance.
    // Do right up-front, so we get in the user types before we are actually
    // doing anything on-chain, this ensures we have the overrides in-place
    if (!options.source) {
      this.registerTypes(options.types);
    } else {
      this.registry.setKnownTypes(options.source.registry.knownTypes);
    }

    this._rpc = this._decorateRpc(this._rpcCore, this._decorateMethod);
    this._rx.rpc = this._decorateRpc(this._rpcCore, this._rxDecorateMethod);
    this._queryMulti = this._decorateMulti(this._decorateMethod);
    this._rx.queryMulti = this._decorateMulti(this._rxDecorateMethod);
    this._rx.signer = options.signer;

    this._rpcCore.provider.on('disconnected', this.#onProviderDisconnect);
    this._rpcCore.provider.on('error', this.#onProviderError);
    this._rpcCore.provider.on('connected', this.#onProviderConnect);

    // If the provider was instantiated earlier, and has already emitted a
    // 'connected' event, then the `on('connected')` won't fire anymore. To
    // cater for this case, we call manually `this._onProviderConnect`.
    if (this._rpcCore.provider.isConnected()) {
      this.#onProviderConnect();
    }
  }

  protected async _loadMeta (): Promise<boolean> {
    const genesisHash = await this._rpcCore.chain.getBlockHash(0).toPromise();

    // on re-connection to the same chain, we don't want to re-do everything from chain again
    if (this._isReady && !this._options.source && genesisHash.eq(this._genesisHash)) {
      return true;
    }

    if (this._genesisHash) {
      l.warn('Connection to new genesis detected, re-initializing');
    }

    this._genesisHash = genesisHash;

    if (this.#updateSub) {
      this.#updateSub.unsubscribe();
    }

    const { metadata = {} } = this._options;

    // only load from on-chain if we are not a clone (default path), alternatively
    // just use the values from the source instance provided
    this._runtimeMetadata = this._options.source?._isReady
      ? await this._metaFromSource(this._options.source)
      : await this._metaFromChain(metadata);

    return this._initFromMeta(this._runtimeMetadata);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  private async _metaFromSource (source: ApiBase<any>): Promise<Metadata> {
    this._extrinsicType = source.extrinsicVersion;
    this._runtimeVersion = source.runtimeVersion;
    this._genesisHash = source.genesisHash;
    this.registry.setChainProperties(source.registry.getChainProperties());

    const methods: string[] = [];

    // manually build a list of all available methods in this RPC, we are
    // going to filter on it to align the cloned RPC without making a call
    Object.keys(source.rpc).forEach((section): void => {
      Object.keys((source.rpc as any)[section]).forEach((method): void => {
        methods.push(`${section}_${method}`);
      });
    });

    this._filterRpcMethods(methods);

    return source.runtimeMetadata;
  }

  // subscribe to metadata updates, inject the types on changes
  private _subscribeUpdates (): void {
    if (this.#updateSub || !this.hasSubscriptions) {
      return;
    }

    this.#updateSub = this._rpcCore.state.subscribeRuntimeVersion().pipe(
      switchMap((version: RuntimeVersion): Observable<boolean> =>
        // only retrieve the metadata when the on-chain version has been changed
        this._runtimeVersion?.specVersion.eq(version.specVersion)
          ? of(false)
          : this._rpcCore.state.getMetadata().pipe(
            map((metadata: Metadata): boolean => {
              l.log(`Runtime version updated to ${version.specVersion}`);

              this._runtimeMetadata = metadata;
              this._runtimeVersion = version;
              this._rx.runtimeVersion = version;

              this.registerTypes(getSpecTypes(this.registry, this._runtimeChain as Text, version.specName, version.specVersion));
              this.injectMetadata(metadata, false);

              return true;
            })
          )
      )
    ).subscribe();
  }

  private async _metaFromChain (optMetadata: Record<string, string>): Promise<Metadata> {
    const [runtimeVersion, chain, chainProps] = await Promise.all([
      this._rpcCore.state.getRuntimeVersion().toPromise(),
      this._rpcCore.system.chain().toPromise(),
      this._rpcCore.system.properties().toPromise()
    ]);

    // set our chain version & genesisHash as returned
    this._runtimeChain = chain;
    this._runtimeVersion = runtimeVersion;
    this._rx.runtimeVersion = runtimeVersion;

    // do the setup for the specific chain
    this.registry.setChainProperties(chainProps);
    this.registerTypes(getSpecTypes(this.registry, chain, runtimeVersion.specName, runtimeVersion.specVersion));
    this._subscribeUpdates();

    // filter the RPC methods (this does an rpc-methods call)
    await this._filterRpc();

    // retrieve metadata, either from chain  or as pass-in via options
    const metadataKey = `${this._genesisHash}-${runtimeVersion.specVersion}`;
    const metadata = metadataKey in optMetadata
      ? new Metadata(this.registry, optMetadata[metadataKey])
      : await this._rpcCore.state.getMetadata().toPromise();

    // get unique types & validate
    metadata.getUniqTypes(false);

    return metadata;
  }

  private async _initFromMeta (metadata: Metadata): Promise<boolean> {
    // inject types based on metadata, if applicable
    this.registerTypes(getMetadataTypes(this.registry, metadata.version));

    const metaExtrinsic = metadata.asLatest.extrinsic;

    // only inject if we are not a clone (global init)
    if (metaExtrinsic.version.gtn(0)) {
      this._extrinsicType = metaExtrinsic.version.toNumber();
    } else if (!this._options.source) {
      // detect the extrinsic version in-use based on the last block
      const { block: { extrinsics: [firstTx] } }: SignedBlock = await this._rpcCore.chain.getBlock().toPromise();

      // If we haven't sync-ed to 1 yes, this won't have any values
      this._extrinsicType = firstTx ? firstTx.type : LATEST_EXTRINSIC_VERSION;
    }

    this._rx.extrinsicType = this._extrinsicType;
    this._rx.genesisHash = this._genesisHash;
    this._rx.runtimeVersion = this._runtimeVersion;

    this.injectMetadata(metadata, true);

    // derive is last, since it uses the decorated rx
    this._rx.derive = this._decorateDeriveRx(this._rxDecorateMethod);
    this._derive = this._decorateDerive(this._decorateMethod);

    return true;
  }

  #onProviderConnect = async (): Promise<void> => {
    this.emit('connected');
    this._isConnected.next(true);

    try {
      const [hasMeta, cryptoReady] = await Promise.all([
        this._loadMeta(),
        this._options.initWasm === false
          ? Promise.resolve(true)
          : cryptoWaitReady()
      ]);

      if (hasMeta && !this._isReady && cryptoReady) {
        this._isReady = true;

        this.emit('ready', this);
      }

      this.#healthTimer = setInterval((): void => {
        this._rpcCore.system.health().toPromise().catch((): void => {
          // ignore
        });
      }, KEEPALIVE_INTERVAL);
    } catch (_error) {
      const error = new Error(`FATAL: Unable to initialize the API: ${_error.message}`);

      l.error(error);

      this.emit('error', error);
    }
  }

  #onProviderDisconnect = (): void => {
    this.emit('disconnected');
    this._isConnected.next(false);

    if (this.#healthTimer) {
      clearInterval(this.#healthTimer);
      this.#healthTimer = null;
    }
  };

  #onProviderError = (error: Error): void => {
    this.emit('error', error);
  };
}
