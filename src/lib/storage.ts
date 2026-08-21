import { randomUUID } from 'crypto';
import type { Readable } from 'stream';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';
import { logger } from '../utils/logger';

/**
 * S3-compatible object storage (Tigris) for chat media (voice messages, etc.).
 *
 * Why: previously voice notes were sent as base64 over the socket and stored
 * inline in Postgres `messages.content`. That bloats the DB, slows every chat
 * history query, and pushes large payloads through the Node process. Now the
 * client uploads the raw audio directly to object storage via a short-lived
 * presigned URL and we only persist/transmit the small public URL.
 */

let _client: S3Client | null = null;

export function isStorageConfigured(): boolean {
  return Boolean(
    env.S3_ENDPOINT &&
      env.S3_BUCKET &&
      env.S3_ACCESS_KEY_ID &&
      env.S3_SECRET_ACCESS_KEY,
  );
}

/**
 * Images are stored in the SAME (private) bucket under the `image/` prefix and
 * served back through our own `/img/<key>` proxy endpoint — so no public bucket
 * or dashboard config is required. We only need object storage + a base URL
 * (APP_URL) to build the stable proxy links. When false, image writes safely
 * keep storing base64 exactly as before (graceful, deploy-ahead-safe).
 */
export function isImageStorageConfigured(): boolean {
  return Boolean(isStorageConfigured() && env.APP_URL);
}

function getClient(): S3Client {
  if (_client) return _client;
  _client = new S3Client({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION || 'auto',
    // Path-style keeps us compatible across S3 providers (Tigris, R2, MinIO…).
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.S3_ACCESS_KEY_ID as string,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY as string,
    },
  });
  return _client;
}

/** True for object keys that hold images (served via the /img proxy). */
function isImageKey(key: string): boolean {
  return key.startsWith('image/');
}

/**
 * All objects live in the single configured bucket. (S3_IMAGE_BUCKET is honored
 * if a separate bucket is ever introduced, but by default images share the
 * voice bucket under the `image/` prefix.)
 */
function bucketForKey(_key: string): string | undefined {
  return env.S3_IMAGE_BUCKET || env.S3_BUCKET;
}

function bucketForFolder(folder: 'voice' | 'image'): string | undefined {
  return folder === 'image' ? env.S3_IMAGE_BUCKET || env.S3_BUCKET : env.S3_BUCKET;
}

/**
 * Build the URL stored for an object key.
 * - Images → a STABLE proxy URL on our own server (`<APP_URL>/img/<key>`) that
 *   streams the object from the private bucket with long cache headers. This
 *   needs no public bucket and lets the app cache images by URL.
 * - Everything else (voice) → the raw bucket URL (only used for presigned access).
 */
export function publicUrlForKey(key: string): string {
  if (isImageKey(key) && env.APP_URL) {
    return `${env.APP_URL.replace(/\/$/, '')}/img/${key}`;
  }
  if (!isImageKey(key) && env.S3_PUBLIC_BASE_URL) {
    return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
  }
  const endpoint = (env.S3_ENDPOINT || '').replace(/\/$/, '');
  return `${endpoint}/${bucketForKey(key)}/${key}`;
}

/**
 * Stream an object out of the (private) bucket — used by the public /img proxy.
 * Returns null when storage is unavailable or the object is missing.
 */
export async function getObjectStream(
  key: string,
): Promise<{ body: Readable; contentType?: string; contentLength?: number } | null> {
  if (!isStorageConfigured() || !key) return null;
  try {
    const out = await getClient().send(
      new GetObjectCommand({ Bucket: bucketForKey(key), Key: key }),
    );
    if (!out.Body) return null;
    return {
      body: out.Body as Readable,
      contentType: out.ContentType,
      contentLength: out.ContentLength,
    };
  } catch (err) {
    logger.warn(`[storage] getObjectStream(${key}) failed:`, err);
    return null;
  }
}

const EXT_BY_FOLDER: Record<string, string> = {
  voice: 'm4a',
  image: 'jpg',
};

/**
 * Generate a presigned PUT URL the client can upload directly to.
 * Returns the upload URL (short TTL) plus the final public URL + object key.
 */
export async function createPresignedUpload(opts: {
  folder: 'voice' | 'image';
  contentType: string;
  ext?: string;
  coupleId?: string;
  expiresInSeconds?: number;
  /**
   * Declared upload size in bytes. When provided it is signed onto the presigned
   * PUT as `Content-Length`, so object storage rejects a body of any other size
   * — a hard, server-enforced size bound. The caller validates it against the
   * per-kind cap BEFORE calling (see chat.controller.createChatUploadUrl). Omit
   * it and the URL is unbounded: kept for the currently-shipped client, which
   * does not declare a length (a presigned PUT cannot express a size RANGE the
   * way a presigned POST policy can — an exact signed Content-Length is the
   * PUT-compatible bound).
   */
  contentLength?: number;
}): Promise<{ uploadUrl: string; publicUrl: string; key: string }> {
  if (!isStorageConfigured()) {
    throw new Error('Object storage is not configured');
  }

  const ext = (opts.ext || EXT_BY_FOLDER[opts.folder] || 'bin').replace(/^\./, '');
  const safeCouple = (opts.coupleId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '');
  const key = `${opts.folder}/${safeCouple}/${Date.now()}-${randomUUID()}.${ext}`;

  const command = new PutObjectCommand({
    Bucket: bucketForFolder(opts.folder),
    Key: key,
    ContentType: opts.contentType,
    // Bind the upload to the declared length when present (S3 signs it as a
    // required header). Omitted → unbounded PUT (shipped client, no size yet).
    ...(typeof opts.contentLength === 'number' && opts.contentLength > 0
      ? { ContentLength: opts.contentLength }
      : {}),
  });

  const uploadUrl = await getSignedUrl(getClient(), command, {
    expiresIn: opts.expiresInSeconds ?? 300,
  });

  return { uploadUrl, publicUrl: publicUrlForKey(key), key };
}

/**
 * Generate a presigned GET URL for an existing object so the client can
 * download/play it. The bucket is private, so playback always goes through a
 * short-lived signed URL (the client caches the downloaded file locally).
 */
export async function createPresignedDownload(
  key: string,
  expiresInSeconds = 6 * 60 * 60,
): Promise<string> {
  if (!isStorageConfigured()) {
    throw new Error('Object storage is not configured');
  }
  const command = new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key });
  return getSignedUrl(getClient(), command, { expiresIn: expiresInSeconds });
}

/** Server-side upload of a buffer (used as a fallback path). */
export async function uploadBuffer(opts: {
  folder: 'voice' | 'image';
  buffer: Buffer;
  contentType: string;
  ext?: string;
  coupleId?: string;
}): Promise<{ publicUrl: string; key: string }> {
  if (!isStorageConfigured()) {
    throw new Error('Object storage is not configured');
  }
  const ext = (opts.ext || EXT_BY_FOLDER[opts.folder] || 'bin').replace(/^\./, '');
  const safeCouple = (opts.coupleId || 'anon').replace(/[^a-zA-Z0-9_-]/g, '');
  const key = `${opts.folder}/${safeCouple}/${Date.now()}-${randomUUID()}.${ext}`;

  await getClient().send(
    new PutObjectCommand({
      Bucket: bucketForFolder(opts.folder),
      Key: key,
      Body: opts.buffer,
      ContentType: opts.contentType,
    }),
  );
  return { publicUrl: publicUrlForKey(key), key };
}

/**
 * Convert a base64 data-URI image into an S3 object and return its public URL.
 * - Already-a-URL (http…) or empty values are returned unchanged.
 * - If storage is not configured, or the upload fails, the original base64 is
 *   returned so nothing ever breaks (graceful degradation / incremental rollout).
 * This is the single choke point that keeps ~0.5 MB base64 blobs out of Postgres.
 */
export async function materializeImage(
  value: string | null | undefined,
  coupleId?: string,
): Promise<string | null | undefined> {
  if (!value || typeof value !== 'string') return value;
  if (!value.startsWith('data:')) return value; // already a URL (or non-image) — leave as-is
  if (!isImageStorageConfigured()) return value; // no public image bucket yet → keep base64
  try {
    const match = /^data:([^;]+);base64,(.*)$/s.exec(value);
    if (!match) return value;
    const contentType = match[1] || 'image/jpeg';
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length) return value;
    const ext = (contentType.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '');
    const { publicUrl } = await uploadBuffer({ folder: 'image', buffer, contentType, ext, coupleId });
    return publicUrl;
  } catch (err) {
    logger.warn('[storage] materializeImage failed — keeping base64:', err);
    return value;
  }
}

/**
 * Like materializeImage but also accepts a RAW base64 string (no data: prefix)
 * and already-stored http URLs. Returns an S3 URL for base64 inputs, or the
 * value unchanged when it's already a URL / empty.
 */
export async function materializeImageLoose(
  value: string | null | undefined,
  coupleId?: string,
): Promise<string | null | undefined> {
  if (!value || typeof value !== 'string') return value;
  if (value.startsWith('http')) return value;
  // Relative image-proxy paths (see GET /img/* in app.ts) are already hosted —
  // never re-wrap them as base64. A real base64 payload starting with exactly
  // "/img/" is practically impossible (~1 in 64^5).
  if (value.startsWith('/img/')) return value;
  const dataUri = value.startsWith('data:') ? value : `data:image/jpeg;base64,${value}`;
  return (await materializeImage(dataUri, coupleId)) ?? value;
}

/** Materialize an array of images (secondary photos). Preserves order + count. */
export async function materializeImages(
  values: (string | null | undefined)[] | null | undefined,
  coupleId?: string,
): Promise<string[]> {
  if (!values || !values.length) return [];
  const out = await Promise.all(
    values.map((v) => materializeImage(v, coupleId).then((r) => (r as string) ?? (v as string))),
  );
  return out.filter((v): v is string => Boolean(v));
}

/** Best-effort delete (e.g. when a media message is deleted). Never throws. */
export async function deleteObjectByUrlOrKey(urlOrKey: string): Promise<void> {
  try {
    if (!isStorageConfigured() || !urlOrKey) return;
    let key = urlOrKey.startsWith('s3:') ? urlOrKey.slice(3) : urlOrKey;
    if (key.startsWith('http')) {
      // Proxy image URLs look like  <APP_URL>/img/image/<couple>/<file>.jpg
      const path = new URL(key).pathname.replace(/^\//, '');
      key = path.startsWith('img/') ? path.slice(4) : path;
      // Fall back: strip a configured public base or leading bucket segment.
      const base = env.S3_PUBLIC_BASE_URL?.replace(/\/$/, '');
      if (base && urlOrKey.startsWith(base)) key = urlOrKey.slice(base.length + 1);
      key = key.replace(new RegExp(`^${env.S3_BUCKET}/`), '');
    }
    if (!key) return;
    await getClient().send(
      new DeleteObjectCommand({ Bucket: bucketForKey(key), Key: key }),
    );
  } catch (err) {
    logger.warn('[storage] deleteObject failed (ignored):', err);
  }
}

/**
 * Best-effort delete of EVERY object under a key prefix (paginated list +
 * batched delete, 1000/req). Never throws — used by account deletion to reclaim
 * a couple's media once their DB rows are gone. Returns quietly when storage is
 * unconfigured so nothing breaks in dev.
 */
export async function deleteByPrefix(prefix: string, bucket?: string): Promise<void> {
  try {
    if (!isStorageConfigured() || !prefix) return;
    const client = getClient();
    const Bucket = bucket || env.S3_BUCKET;
    let ContinuationToken: string | undefined;
    do {
      const listed = await client.send(
        new ListObjectsV2Command({ Bucket, Prefix: prefix, ContinuationToken }),
      );
      const objects = (listed.Contents ?? [])
        .map((o) => o.Key)
        .filter((k): k is string => Boolean(k))
        .map((Key) => ({ Key }));
      if (objects.length) {
        await client.send(
          new DeleteObjectsCommand({ Bucket, Delete: { Objects: objects, Quiet: true } }),
        );
      }
      ContinuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
    } while (ContinuationToken);
  } catch (err) {
    logger.warn(`[storage] deleteByPrefix(${prefix}) failed (ignored):`, err);
  }
}

/**
 * Delete all of a couple's stored media — profile photos (`image/<couple>/`) and
 * chat voice notes (`voice/<couple>/`) — each from its own bucket (they may be
 * split; by default both resolve to S3_BUCKET). The couple-folder sanitization
 * mirrors the key builder in createPresignedUpload/uploadBuffer. Best-effort.
 */
export async function deleteCoupleMedia(coupleId: string): Promise<void> {
  const safe = (coupleId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return;
  await deleteByPrefix(`image/${safe}/`, env.S3_IMAGE_BUCKET || env.S3_BUCKET);
  await deleteByPrefix(`voice/${safe}/`, env.S3_BUCKET);
}
