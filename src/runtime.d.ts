interface CacheStorage {
  readonly default: Cache;
}

interface SubtleCrypto {
  timingSafeEqual(first: BufferSource, second: BufferSource): boolean;
}
