import { CacheKeyManifest } from './key-manifest';

import {
  CacheEntry,
  ICache,
  CacheKey,
  CACHE_KEY_PREFIX,
  WrappedCacheEntry
} from './shared';

const DEFAULT_EXPIRY_ADJUSTMENT_SECONDS = 0;

export class CacheManager {
  private readonly keyManifest?: CacheKeyManifest;

  constructor(private cache: ICache, clientId: string) {
    // If the cache implementation doesn't provide an `allKeys` method,
    // use a built-in key manifest.
    if (!cache.allKeys) {
      this.keyManifest = new CacheKeyManifest(this.cache, clientId);
    }
  }

  async get(
    cacheKey: CacheKey,
    expiryAdjustmentSeconds = DEFAULT_EXPIRY_ADJUSTMENT_SECONDS
  ): Promise<Partial<CacheEntry> | undefined> {
    let wrappedEntry = await this.cache.get<WrappedCacheEntry>(
      cacheKey.toKey()
    );

    console.log(
      `cache manager trying to get: ${JSON.stringify(cacheKey.toKey())}`
    );
    console.log(
      `cache manager original wrappedEntry: ${JSON.stringify(wrappedEntry)}`
    );

    if (!wrappedEntry) {
      const keys = await this.getCacheKeys();

      console.log(`cache manager getCacheKeys: ${JSON.stringify(keys)}`);

      if (!keys) return;

      const matchedKey = this.matchExistingCacheKey(cacheKey, keys);
      console.log(`cache manager matchedKey: ${JSON.stringify(matchedKey)}`);

      wrappedEntry = await this.cache.get<WrappedCacheEntry>(matchedKey);
    }

    console.log(
      `cache manager new wrappedEntry: ${JSON.stringify(wrappedEntry)}`
    );
    // If we still don't have an entry, exit.
    if (!wrappedEntry) {
      return;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);

    console.log(
      `cache wrapped entry expiry test: ${
        wrappedEntry.expiresAt - expiryAdjustmentSeconds
      } < ${nowSeconds}`
    );
    if (wrappedEntry.expiresAt - expiryAdjustmentSeconds < nowSeconds) {
      console.log(`cache now appending a refresh token`);
      if (wrappedEntry.body.refresh_token) {
        wrappedEntry.body = {
          refresh_token: wrappedEntry.body.refresh_token
        };

        await this.cache.set(cacheKey.toKey(), wrappedEntry);
        return wrappedEntry.body;
      }

      console.log(`cache now removing ${JSON.stringify(cacheKey.toKey())}`);
      await this.cache.remove(cacheKey.toKey());
      console.log(
        `cache keyManifest now removing ${JSON.stringify(cacheKey.toKey())}`
      );

      await this.keyManifest?.remove(cacheKey.toKey());

      return;
    }

    return wrappedEntry.body;
  }

  async set(entry: CacheEntry): Promise<void> {
    const cacheKey = new CacheKey({
      client_id: entry.client_id,
      scope: entry.scope,
      audience: entry.audience
    });

    const wrappedEntry = this.wrapCacheEntry(entry);

    console.log(
      `writing ${JSON.stringify(wrappedEntry)} at key ${cacheKey.toKey()}`
    );

    await this.cache.set(cacheKey.toKey(), wrappedEntry);
    await this.keyManifest?.add(cacheKey.toKey());
  }

  async clear(): Promise<void> {
    const keys = await this.getCacheKeys();

    console.log(`!!!cache was cleared!!!`);

    /* istanbul ignore next */
    if (!keys) return;

    keys.forEach(async key => {
      await this.cache.remove(key);
    });

    await this.keyManifest?.clear();
  }

  /**
   * Note: only call this if you're sure one of our internal (synchronous) caches are being used.
   */
  clearSync(): void {
    const keys = this.cache.allKeys() as string[];

    /* istanbul ignore next */
    if (!keys) return;

    keys.forEach(key => {
      this.cache.remove(key);
    });
  }

  private wrapCacheEntry(entry: CacheEntry): WrappedCacheEntry {
    const expiresInTime = Math.floor(Date.now() / 1000) + entry.expires_in;

    console.log(`wrapCacheEntry entry expires_in: ${entry.expires_in}`);
    console.log(`wrapCacheEntry expiresInTime: ${expiresInTime}`);
    console.log(`wrapCacheEntry claims.exp ${entry.decodedToken.claims.exp}`);

    const expirySeconds = Math.min(
      expiresInTime,
      entry.decodedToken.claims.exp
    );

    return {
      body: entry,
      expiresAt: expirySeconds
    };
  }

  private async getCacheKeys(): Promise<string[]> {
    console.log(`getCacheKeys: using manifest: ${this.keyManifest}`);
    return this.keyManifest
      ? (await this.keyManifest.get())?.keys
      : await this.cache.allKeys();
  }

  /**
   * Finds the corresponding key in the cache based on the provided cache key.
   * The keys inside the cache are in the format {prefix}::{client_id}::{audience}::{scope}.
   * The first key in the cache that satisfies the following conditions is returned
   *  - `prefix` is strict equal to Auth0's internally configured `keyPrefix`
   *  - `client_id` is strict equal to the `cacheKey.client_id`
   *  - `audience` is strict equal to the `cacheKey.audience`
   *  - `scope` contains at least all the `cacheKey.scope` values
   *  *
   * @param keyToMatch The provided cache key
   * @param allKeys A list of existing cache keys
   */
  private matchExistingCacheKey(keyToMatch: CacheKey, allKeys: Array<string>) {
    return allKeys.filter(key => {
      const cacheKey = CacheKey.fromKey(key);
      const scopeSet = new Set(cacheKey.scope && cacheKey.scope.split(' '));
      const scopesToMatch = keyToMatch.scope.split(' ');

      const hasAllScopes =
        cacheKey.scope &&
        scopesToMatch.reduce(
          (acc, current) => acc && scopeSet.has(current),
          true
        );

      return (
        cacheKey.prefix === CACHE_KEY_PREFIX &&
        cacheKey.client_id === keyToMatch.client_id &&
        cacheKey.audience === keyToMatch.audience &&
        hasAllScopes
      );
    })[0];
  }
}
