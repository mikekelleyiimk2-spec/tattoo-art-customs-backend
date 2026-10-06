// Upload tattoo gallery preview JPEGs to Cloudflare R2 (S3-compatible API).
// Credentials come ONLY from env vars — never hardcode them here:
//   R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET
// Key convention: designs/<basename>  (matches backend storage module kind='designs')
// Idempotent: skips objects already present with a matching size (HeadObject).
// Startup: deletes any orphan objects under previews/ (old convention).
// Writes manifest: scripts/r2-upload-manifest.json  (relative path -> key/size/ETag)
const fs = require('fs');
const path = require('path');
const {
  S3Client,
  HeadObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require('@aws-sdk/client-s3');

const PREVIEW_DIR = path.join(__dirname, '..', 'assets', 'designs', 'linework-wm');
const MANIFEST_PATH = path.join(__dirname, 'r2-upload-manifest.json');
const CONCURRENCY = 5;

const {
  R2_ENDPOINT,
  R2_ACCESS_KEY_ID,
  R2_SECRET_ACCESS_KEY,
  R2_BUCKET,
} = process.env;

for (const [name, val] of Object.entries({
  R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET,
})) {
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ENDPOINT,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: false,
});

function walk(dir, base, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile()) out.push(path.relative(base, full));
  }
  return out;
}

async function headSize(key) {
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return { size: res.ContentLength, etag: res.ETag };
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

// Delete orphan objects from the old previews/ convention (returns count deleted).
async function cleanupPreviewsOrphans() {
  let token;
  let deleted = 0;
  do {
    const listed = await s3.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET,
      Prefix: 'previews/',
      ContinuationToken: token,
      MaxKeys: 1000,
    }));
    const keys = (listed.Contents || []).map((o) => o.Key);
    if (keys.length) {
      const res = await s3.send(new DeleteObjectsCommand({
        Bucket: R2_BUCKET,
        Delete: { Objects: keys.map((Key) => ({ Key })) },
      }));
      deleted += (res.Deleted || []).length;
      if ((res.Errors || []).length) {
        console.error('orphan delete errors:', JSON.stringify(res.Errors.slice(0, 5)));
      }
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

async function run() {
  const orphans = await cleanupPreviewsOrphans();
  console.log(`Cleaned up ${orphans} orphan object(s) under previews/`);

  const files = walk(PREVIEW_DIR, PREVIEW_DIR, []);
  console.log(`Found ${files.length} files under ${PREVIEW_DIR}`);

  const manifest = {};
  try {
    Object.assign(manifest, JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')));
  } catch (_) { /* first run */ }

  let uploaded = 0, skipped = 0, failed = 0;
  let bytesUploaded = 0;
  const failures = [];

  const queue = files.slice();
  async function worker() {
    while (queue.length) {
      const rel = queue.shift();
      const key = 'designs/' + path.basename(rel); // backend kind='designs' convention
      const full = path.join(PREVIEW_DIR, rel);
      let size;
      try {
        size = fs.statSync(full).size;
      } catch (err) {
        failed++;
        failures.push({ rel, error: `stat failed: ${err.message}` });
        continue;
      }
      try {
        // Idempotency: skip when remote size matches local size.
        const existing = await headSize(key);
        if (existing && existing.size === size) {
          skipped++;
          manifest[rel] = { key, size, etag: existing.etag };
          continue;
        }
        const body = fs.readFileSync(full);
        const put = await s3.send(new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: body,
          ContentType: 'image/jpeg',
          ContentLength: size,
        }));
        // Verify: re-stat the object and compare size.
        const verify = await headSize(key);
        if (!verify || verify.size !== size) {
          throw new Error(`verification failed (remote size ${verify?.size ?? 'missing'} != local ${size})`);
        }
        manifest[rel] = { key, size, etag: verify.etag || put.ETag };
        uploaded++;
        bytesUploaded += size;
        if ((uploaded + skipped) % 100 === 0) {
          console.log(`progress: uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
        }
      } catch (err) {
        failed++;
        failures.push({ rel, error: err.message });
        console.error(`FAILED ${rel}: ${err.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('--- DONE ---');
  console.log(`total=${files.length} uploaded=${uploaded} skipped=${skipped} failed=${failed} bytes_uploaded=${bytesUploaded}`);
  console.log(`manifest: ${MANIFEST_PATH}`);
  if (failures.length) {
    console.log('failures:');
    for (const f of failures) console.log(`  ${f.rel}: ${f.error}`);
  }
  process.exit(failed ? 2 : 0);
}

run().catch((err) => { console.error('fatal:', err); process.exit(1); });
