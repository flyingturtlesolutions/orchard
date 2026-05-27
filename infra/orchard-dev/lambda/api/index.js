/**
 * Orchard P0/P1 API — identity, object CRUD, batch writes, change feed.
 */
const crypto = require('node:crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} = require('@aws-sdk/lib-dynamodb');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const IDENTITY_TABLE = process.env.IDENTITY_TABLE;
const OBJECT_TABLE = process.env.OBJECT_TABLE;
const WORKSPACE_BUCKET = process.env.WORKSPACE_BUCKET;
const MAX_BATCH = 10;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function routePath(event) {
  return (event.requestContext?.http?.path || '').replace(/^\/v1/, '') || '/';
}

function jwtClaims(event) {
  return event.requestContext?.authorizer?.jwt?.claims || {};
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

function b64urlToBuf(s) {
  return Buffer.from(s, 'base64url');
}

function deriveOrchardUserId(publicKeyRaw) {
  const hash = crypto.createHash('sha256').update(publicKeyRaw).digest();
  return `pk_${hash.toString('base64url').slice(0, 22)}`;
}

function importEd25519PublicKey(raw32) {
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([prefix, raw32]),
    format: 'der',
    type: 'spki',
  });
}

function verifyEd25519(publicKeyB64, messageBytes, signatureB64) {
  const key = importEd25519PublicKey(b64urlToBuf(publicKeyB64));
  return crypto.verify(null, messageBytes, key, b64urlToBuf(signatureB64));
}

function pathHash(logicalPath) {
  return crypto.createHash('sha256').update(logicalPath).digest('hex').slice(0, 12);
}

function gsi2Sk(updatedAt, logicalPath) {
  return `TS#${String(updatedAt).padStart(13, '0')}#${pathHash(logicalPath)}`;
}

function isPathDenied(logicalPath) {
  if (!logicalPath || logicalPath.includes('..')) return true;
  if (logicalPath.startsWith('refs/')) return true;
  if (logicalPath.startsWith('runtime/')) return true;
  if (logicalPath.includes('_userPrivate')) return true;
  if (logicalPath.includes('/private/')) return true;
  if (logicalPath === 'meta/deviceId.json') return true;
  return false;
}

function extractGroundId(logicalPath) {
  const m = logicalPath.match(/^workspace\/grounds\/([^/]+)/);
  return m ? m[1] : null;
}

function extractPrimitiveType(logicalPath) {
  if (logicalPath.endsWith('/ground.json')) return 'ground';
  if (logicalPath.includes('/tier1/fragments/')) return 'fragment';
  if (logicalPath.includes('/tier1/observations/')) return 'observation';
  if (logicalPath.includes('/tier1/analyses/')) return 'analysis';
  if (logicalPath.includes('/tier1/assertions/')) return 'assertion';
  if (logicalPath.includes('/workflows/')) return 'workflow';
  if (logicalPath.includes('/perspectives/')) return 'perspective';
  if (logicalPath.includes('/substrate/landmarks/')) return 'landmark';
  if (logicalPath.includes('/strategies/')) return 'strategy';
  if (logicalPath.includes('/locales/')) return 'locale';
  if (logicalPath.endsWith('/siteMap.json')) return 'siteMap';
  if (logicalPath.endsWith('/chrome.json')) return 'chrome';
  if (logicalPath.endsWith('/_manifest.json')) return 'manifest';
  return 'object';
}

function tierForPath(logicalPath) {
  if (logicalPath.includes('/workflows/') && logicalPath.endsWith('.json') && !logicalPath.endsWith('/_manifest.json')) {
    return 2;
  }
  if (logicalPath.includes('workspace/strategies/')) return 3;
  if (logicalPath.endsWith('/ground.json') || logicalPath.endsWith('/siteMap.json') || logicalPath.endsWith('/chrome.json')) return 2;
  if (logicalPath.includes('/intents/')) return 2;
  return 1;
}

function conflictResolution(logicalPath, clientEnvelope, serverEnvelope) {
  const tier = tierForPath(logicalPath);
  if (tier >= 2 || logicalPath.endsWith('/_manifest.json')) {
    return {
      resolution: 'manual-required',
      suggestedAction: 'open-merge',
    };
  }
  if (clientEnvelope?.updatedAt > serverEnvelope?.updatedAt) {
    return {
      resolution: 'auto-lww-allowed',
      suggestedAction: 'keep-mine',
    };
  }
  return {
    resolution: 'manual-required',
    suggestedAction: 'keep-theirs',
  };
}

async function getIdentityRecord(cognitoSub) {
  const res = await ddb.send(new GetCommand({
    TableName: IDENTITY_TABLE,
    Key: { PK: `COGNITO#${cognitoSub}` },
  }));
  return res.Item || null;
}

async function requireOrchardUser(event) {
  const claims = jwtClaims(event);
  const sub = claims.sub;
  if (!sub) return { error: json(401, { error: 'unauthorized' }) };
  const record = await getIdentityRecord(sub);
  if (!record?.orchardUserId) {
    return { error: json(403, { error: 'identity_not_bound' }) };
  }
  return { orchardUserId: record.orchardUserId, claims };
}

function objectKeys(orchardUserId, logicalPath) {
  return {
    PK: `USER#${orchardUserId}`,
    SK: `PATH#${logicalPath}`,
  };
}

async function getIndexRecord(orchardUserId, logicalPath) {
  const res = await ddb.send(new GetCommand({
    TableName: OBJECT_TABLE,
    Key: objectKeys(orchardUserId, logicalPath),
  }));
  return res.Item || null;
}

async function removeIndexRecord(orchardUserId, logicalPath) {
  await ddb.send(new DeleteCommand({
    TableName: OBJECT_TABLE,
    Key: objectKeys(orchardUserId, logicalPath),
  }));
}

/** @returns {Promise<boolean>} */
async function s3ObjectExists(orchardUserId, logicalPath) {
  try {
    await s3.send(new HeadObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: s3Key(orchardUserId, logicalPath),
    }));
    return true;
  } catch {
    return false;
  }
}

function s3Key(orchardUserId, logicalPath) {
  return `users/${orchardUserId}/${logicalPath}`;
}

function stagingS3Key(orchardUserId, uploadId) {
  return `users/${orchardUserId}/_staging/${uploadId}`;
}

const PRESIGN_TTL_SECONDS = 900;
const INLINE_OBJECT_MAX_BYTES = 256 * 1024;
// Hard cap on the raw request body, checked before any JSON.parse — bounds the cost/DoS surface
// (S3 PUT + KMS + DDB per write). Generous enough for a full /objects/batch, well under the
// API Gateway 10 MB ceiling.
const MAX_REQUEST_BODY_BYTES = 5 * 1024 * 1024;

function normalizeEtag(etag) {
  if (!etag) return null;
  return etag.replace(/^"|"$/g, '');
}

function parseIfMatch(event) {
  const raw = event.headers?.['if-match'] || event.headers?.['If-Match'] || '*';
  return raw === '*' ? '*' : normalizeEtag(raw);
}

async function handleIdentityMe(event) {
  const claims = jwtClaims(event);
  const sub = claims.sub;
  if (!sub) return json(401, { error: 'unauthorized' });

  const record = await getIdentityRecord(sub);
  return json(200, {
    cognitoSub: sub,
    email: claims.email || null,
    orchardUserId: record?.orchardUserId || null,
    bound: !!record?.orchardUserId,
    publicKey: record?.publicKey || null,
  });
}

async function handleBindChallenge(event) {
  const claims = jwtClaims(event);
  const sub = claims.sub;
  if (!sub) return json(401, { error: 'unauthorized' });

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const { publicKey } = body;
  if (!publicKey || typeof publicKey !== 'string') {
    return json(400, { error: 'publicKey required' });
  }

  const challenge = b64url(crypto.randomBytes(32));
  const ttl = Math.floor(Date.now() / 1000) + 300;

  await ddb.send(new PutCommand({
    TableName: IDENTITY_TABLE,
    Item: {
      PK: `CHALLENGE#${sub}`,
      challenge,
      publicKey,
      ttl,
    },
  }));

  return json(200, { challenge });
}

async function handleBind(event) {
  const claims = jwtClaims(event);
  const sub = claims.sub;
  if (!sub) return json(401, { error: 'unauthorized' });

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const { publicKey, challenge, signature } = body;
  if (!publicKey || !challenge || !signature) {
    return json(400, { error: 'publicKey, challenge, signature required' });
  }

  const pending = await ddb.send(new GetCommand({
    TableName: IDENTITY_TABLE,
    Key: { PK: `CHALLENGE#${sub}` },
  }));

  const pendingItem = pending.Item;
  if (!pendingItem || pendingItem.challenge !== challenge || pendingItem.publicKey !== publicKey) {
    return json(409, { error: 'invalid_challenge' });
  }

  const challengeBytes = b64urlToBuf(challenge);
  if (!verifyEd25519(publicKey, challengeBytes, signature)) {
    return json(401, { error: 'invalid_signature' });
  }

  const existing = await getIdentityRecord(sub);
  // One workspace per Cognito account — additional devices reuse the same
  // orchardUserId instead of deriving a new pk_* namespace from each keypair.
  const orchardUserId = existing?.orchardUserId
    ?? deriveOrchardUserId(b64urlToBuf(publicKey));
  const devicePublicKeys = Array.isArray(existing?.devicePublicKeys)
    ? [...existing.devicePublicKeys]
    : (existing?.publicKey ? [existing.publicKey] : []);
  if (!devicePublicKeys.includes(publicKey)) {
    devicePublicKeys.push(publicKey);
  }
  const now = Date.now();

  await ddb.send(new PutCommand({
    TableName: IDENTITY_TABLE,
    Item: {
      PK: `COGNITO#${sub}`,
      orchardUserId,
      publicKey,
      devicePublicKeys,
      email: claims.email || null,
      boundAt: existing?.boundAt || now,
      lastBoundAt: now,
    },
  }));

  await ddb.send(new DeleteCommand({
    TableName: IDENTITY_TABLE,
    Key: { PK: `CHALLENGE#${sub}` },
  }));

  return json(200, { orchardUserId, boundAt: now });
}

async function resolveObjectSizeBytes(orchardUserId, logicalPath, index) {
  if (typeof index?.sizeBytes === 'number' && index.sizeBytes > 0) {
    return index.sizeBytes;
  }
  try {
    const head = await s3.send(new HeadObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: s3Key(orchardUserId, logicalPath),
    }));
    return head.ContentLength || 0;
  } catch {
    return 0;
  }
}

async function presignedGetUrl(orchardUserId, logicalPath) {
  const command = new GetObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: s3Key(orchardUserId, logicalPath),
  });
  return getSignedUrl(s3, command, { expiresIn: PRESIGN_TTL_SECONDS });
}

async function handleGetObject(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  const path = routePath(event);
  const logicalPath = decodeURIComponent(path.replace(/^\/objects\/?/, ''));
  if (!logicalPath || isPathDenied(logicalPath)) {
    return json(logicalPath ? 403 : 400, { error: logicalPath ? 'path_denied' : 'invalid_path' });
  }

  const index = await getIndexRecord(auth.orchardUserId, logicalPath);
  if (index?.deleted) {
    return json(404, { error: 'not_found', path: logicalPath });
  }

  const key = s3Key(auth.orchardUserId, logicalPath);
  if (index && !(await s3ObjectExists(auth.orchardUserId, logicalPath))) {
    await removeIndexRecord(auth.orchardUserId, logicalPath);
    return json(404, { error: 'not_found', path: logicalPath, orphan: true });
  }

  const sizeBytes = await resolveObjectSizeBytes(auth.orchardUserId, logicalPath, index);

  if (sizeBytes > INLINE_OBJECT_MAX_BYTES) {
    const downloadUrl = await presignedGetUrl(auth.orchardUserId, logicalPath);
    const etag = normalizeEtag(index?.etag || '');
    return {
      statusCode: 302,
      headers: {
        location: downloadUrl,
        ...(etag ? { 'x-orchard-etag': etag } : {}),
        'x-orchard-size-bytes': String(sizeBytes),
        'access-control-expose-headers': 'location, x-orchard-etag, x-orchard-size-bytes',
      },
      body: '',
    };
  }

  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: key,
    }));
    const body = await obj.Body.transformToString();
    return {
      statusCode: 200,
      headers: {
        'content-type': obj.ContentType || 'application/json',
        etag: obj.ETag || '',
      },
      body,
    };
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      return json(404, { error: 'not_found', path: logicalPath });
    }
    throw e;
  }
}

async function handleListObjects(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  const since = event.queryStringParameters?.since || '';
  const limit = Math.min(Number(event.queryStringParameters?.limit || '100'), 500);

  const params = {
    TableName: OBJECT_TABLE,
    IndexName: 'ChangeFeed',
    KeyConditionExpression: 'GSI2PK = :pk',
    ExpressionAttributeValues: {
      ':pk': `USER#${auth.orchardUserId}`,
    },
    Limit: limit,
    ScanIndexForward: true,
  };

  if (since) {
    params.KeyConditionExpression += ' AND GSI2SK > :since';
    params.ExpressionAttributeValues[':since'] = since;
  }

  const res = await ddb.send(new QueryCommand(params));
  const changes = (res.Items || []).map((item) => ({
    path: item.path,
    etag: item.etag,
    updatedAt: item.updatedAt,
    groundId: item.groundId || null,
    primitiveType: item.primitiveType || null,
    deleted: item.deleted === true,
  }));

  const nextToken = changes.length > 0 ? res.Items[res.Items.length - 1].GSI2SK : since;

  return json(200, { changes, nextToken });
}

async function checkEtagConflict(orchardUserId, logicalPath, expectedEtag, clientEnvelope = null) {
  if (expectedEtag === '*') return null;

  const existing = await getIndexRecord(orchardUserId, logicalPath);
  const serverEtag = existing?.etag || null;
  if (!serverEtag || normalizeEtag(expectedEtag) === normalizeEtag(serverEtag)) {
    return null;
  }

  let serverBody = null;
  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: s3Key(orchardUserId, logicalPath),
    }));
    serverBody = JSON.parse(await obj.Body.transformToString());
  } catch {
    serverBody = null;
  }

  const meta = conflictResolution(logicalPath, clientEnvelope || {}, serverBody);
  return json(409, {
    error: 'conflict',
    path: logicalPath,
    server: serverBody,
    client: clientEnvelope,
    ...meta,
  });
}

async function registerObjectIndex(orchardUserId, logicalPath, envelope, etag, sizeBytes, s3VersionId = null) {
  const updatedAt = envelope.updatedAt || Date.now();
  const indexItem = {
    ...objectKeys(orchardUserId, logicalPath),
    GSI2PK: `USER#${orchardUserId}`,
    GSI2SK: gsi2Sk(updatedAt, logicalPath),
    path: logicalPath,
    groundId: extractGroundId(logicalPath),
    primitiveType: extractPrimitiveType(logicalPath),
    schemaVersion: envelope.schemaVersion || 1,
    updatedAt,
    etag,
    sizeBytes,
    lifecycle: envelope.lifecycle || 'active',
    s3VersionId,
    deleted: false,
  };

  await ddb.send(new PutCommand({
    TableName: OBJECT_TABLE,
    Item: indexItem,
  }));

  return { path: logicalPath, etag, updatedAt };
}

async function writeOneObject(orchardUserId, item) {
  const { path: logicalPath, envelope } = item;
  const expectedEtag = item.expectedEtag ?? '*';

  if (!logicalPath || !envelope || isPathDenied(logicalPath)) {
    return { error: json(400, { error: 'invalid_item', path: logicalPath }) };
  }

  const conflict = await checkEtagConflict(orchardUserId, logicalPath, expectedEtag, envelope);
  if (conflict) return { conflict };

  const bodyStr = JSON.stringify(envelope);
  const putRes = await s3.send(new PutObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: s3Key(orchardUserId, logicalPath),
    Body: bodyStr,
    ContentType: 'application/json',
  }));

  const etag = normalizeEtag(putRes.ETag || crypto.createHash('md5').update(bodyStr).digest('hex'));
  return registerObjectIndex(
    orchardUserId,
    logicalPath,
    envelope,
    etag,
    Buffer.byteLength(bodyStr),
    putRes.VersionId || null,
  );
}

async function handlePresignPut(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const logicalPath = body.path;
  if (!logicalPath || isPathDenied(logicalPath)) {
    return json(logicalPath ? 403 : 400, { error: logicalPath ? 'path_denied' : 'invalid_path' });
  }

  const expectedEtag = body.expectedEtag ?? '*';
  const conflict = await checkEtagConflict(auth.orchardUserId, logicalPath, expectedEtag);
  if (conflict) return conflict;

  const uploadId = crypto.randomUUID();
  const stagingKey = stagingS3Key(auth.orchardUserId, uploadId);
  const command = new PutObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: stagingKey,
    ContentType: 'application/json',
  });
  const uploadUrl = await getSignedUrl(s3, command, { expiresIn: PRESIGN_TTL_SECONDS });

  return json(200, {
    uploadUrl,
    uploadId,
    path: logicalPath,
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    expiresIn: PRESIGN_TTL_SECONDS,
  });
}

async function handleCompletePut(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const logicalPath = body.path;
  const uploadId = body.uploadId;
  if (!logicalPath || !uploadId || isPathDenied(logicalPath)) {
    return json(400, { error: 'path_and_uploadId_required' });
  }

  const expectedEtag = body.expectedEtag ?? '*';
  const stagingKey = stagingS3Key(auth.orchardUserId, uploadId);
  const finalKey = s3Key(auth.orchardUserId, logicalPath);

  try {
    await s3.send(new HeadObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: stagingKey,
    }));
  } catch (e) {
    if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
      return json(404, { error: 'upload_not_found', path: logicalPath, uploadId });
    }
    throw e;
  }

  let envelope;
  try {
    const obj = await s3.send(new GetObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: stagingKey,
    }));
    envelope = JSON.parse(await obj.Body.transformToString());
  } catch {
    return json(400, { error: 'invalid_upload_body', path: logicalPath });
  }

  const conflict = await checkEtagConflict(auth.orchardUserId, logicalPath, expectedEtag, envelope);
  if (conflict) {
    try {
      await s3.send(new DeleteObjectCommand({ Bucket: WORKSPACE_BUCKET, Key: stagingKey }));
    } catch { /* best effort */ }
    return conflict;
  }

  const bodyStr = JSON.stringify(envelope);
  const putRes = await s3.send(new PutObjectCommand({
    Bucket: WORKSPACE_BUCKET,
    Key: finalKey,
    Body: bodyStr,
    ContentType: 'application/json',
  }));

  try {
    await s3.send(new DeleteObjectCommand({ Bucket: WORKSPACE_BUCKET, Key: stagingKey }));
  } catch { /* best effort */ }

  const etag = normalizeEtag(putRes.ETag || crypto.createHash('md5').update(bodyStr).digest('hex'));
  const result = await registerObjectIndex(
    auth.orchardUserId,
    logicalPath,
    envelope,
    etag,
    Buffer.byteLength(bodyStr),
    putRes.VersionId || null,
  );

  return json(200, { path: result.path, etag: result.etag, updatedAt: result.updatedAt });
}

async function handlePutObject(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  const path = routePath(event);
  const logicalPath = decodeURIComponent(path.replace(/^\/objects\/?/, ''));
  if (!logicalPath || isPathDenied(logicalPath)) {
    return json(logicalPath ? 403 : 400, { error: logicalPath ? 'path_denied' : 'invalid_path' });
  }

  let envelope;
  try {
    envelope = event.body ? JSON.parse(event.body) : null;
  } catch {
    return json(400, { error: 'invalid_json' });
  }
  if (!envelope) return json(400, { error: 'envelope required' });

  const expectedEtag = parseIfMatch(event);
  const result = await writeOneObject(auth.orchardUserId, {
    path: logicalPath,
    envelope,
    expectedEtag,
  });

  if (result.conflict) return result.conflict;
  if (result.error) return result.error;

  return json(200, { path: result.path, etag: result.etag, updatedAt: result.updatedAt });
}

async function handleDeleteObject(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  const path = routePath(event);
  const logicalPath = decodeURIComponent(path.replace(/^\/objects\/?/, ''));
  if (!logicalPath || isPathDenied(logicalPath)) {
    return json(logicalPath ? 403 : 400, { error: logicalPath ? 'path_denied' : 'invalid_path' });
  }

  const existing = await getIndexRecord(auth.orchardUserId, logicalPath);
  const updatedAt = Math.max(Date.now(), (existing?.updatedAt || 0) + 1);

  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: WORKSPACE_BUCKET,
      Key: s3Key(auth.orchardUserId, logicalPath),
    }));
  } catch (e) {
    if (e.name !== 'NoSuchKey' && e.$metadata?.httpStatusCode !== 404) throw e;
  }

  await ddb.send(new PutCommand({
    TableName: OBJECT_TABLE,
    Item: {
      ...objectKeys(auth.orchardUserId, logicalPath),
      GSI2PK: `USER#${auth.orchardUserId}`,
      GSI2SK: gsi2Sk(updatedAt, logicalPath),
      path: logicalPath,
      groundId: extractGroundId(logicalPath),
      primitiveType: extractPrimitiveType(logicalPath),
      updatedAt,
      deleted: true,
      etag: existing?.etag || null,
    },
  }));

  return json(200, { deleted: true, path: logicalPath, updatedAt });
}

async function handleBatchWrite(event) {
  const auth = await requireOrchardUser(event);
  if (auth.error) return auth.error;

  let body = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const items = body.items;
  if (!Array.isArray(items) || items.length === 0) {
    return json(400, { error: 'items array required' });
  }
  if (items.length > MAX_BATCH) {
    return json(400, { error: 'batch_too_large', max: MAX_BATCH });
  }

  for (const item of items) {
    if (isPathDenied(item.path)) {
      return json(403, { error: 'path_denied', path: item.path });
    }
  }

  // Pre-check all etags (all-or-nothing)
  for (const item of items) {
    const expectedEtag = item.expectedEtag ?? '*';
    const existing = await getIndexRecord(auth.orchardUserId, item.path);
    const serverEtag = existing?.etag || null;
    if (expectedEtag !== '*' && serverEtag && normalizeEtag(expectedEtag) !== normalizeEtag(serverEtag)) {
      let serverBody = null;
      try {
        const obj = await s3.send(new GetObjectCommand({
          Bucket: WORKSPACE_BUCKET,
          Key: s3Key(auth.orchardUserId, item.path),
        }));
        serverBody = JSON.parse(await obj.Body.transformToString());
      } catch {
        serverBody = null;
      }
      const meta = conflictResolution(item.path, item.envelope, serverBody);
      return json(409, {
        error: 'conflict',
        path: item.path,
        server: serverBody,
        client: item.envelope,
        ...meta,
      });
    }
  }

  const written = [];
  const s3KeysWritten = [];

  try {
    for (const item of items) {
      const result = await writeOneObject(auth.orchardUserId, item);
      if (result.conflict) {
        throw Object.assign(new Error('conflict'), { response: result.conflict });
      }
      if (result.error) {
        throw Object.assign(new Error('write_failed'), { response: result.error });
      }
      written.push(result);
      s3KeysWritten.push(s3Key(auth.orchardUserId, item.path));
    }
  } catch (e) {
    for (const key of s3KeysWritten) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: WORKSPACE_BUCKET, Key: key }));
      } catch { /* best effort rollback */ }
    }
    if (e.response) return e.response;
    throw e;
  }

  const etags = Object.fromEntries(written.map((w) => [w.path, w.etag]));
  const updatedAt = Math.max(...written.map((w) => w.updatedAt));

  return json(200, { etags, updatedAt, count: written.length });
}

exports.handler = async (event) => {
  try {
    const method = event.requestContext?.http?.method || 'GET';
    const path = routePath(event);

    // Reject oversized bodies up front (before any JSON.parse) — cost/DoS guard.
    if (event.body && Buffer.byteLength(event.body, event.isBase64Encoded ? 'base64' : 'utf8') > MAX_REQUEST_BODY_BYTES) {
      return json(413, { error: 'payload_too_large', limitBytes: MAX_REQUEST_BODY_BYTES });
    }

    if (method === 'GET' && path === '/identity/me') return handleIdentityMe(event);
    if (method === 'POST' && path === '/identity/bind/challenge') return handleBindChallenge(event);
    if (method === 'POST' && path === '/identity/bind') return handleBind(event);

    if (method === 'GET' && path === '/objects') return handleListObjects(event);
    if (method === 'POST' && path === '/objects/presign-put') return handlePresignPut(event);
    if (method === 'POST' && path === '/objects/complete-put') return handleCompletePut(event);
    if (method === 'POST' && path === '/objects/batch') return handleBatchWrite(event);
    if (method === 'GET' && path.startsWith('/objects/')) return handleGetObject(event);
    if (method === 'PUT' && path.startsWith('/objects/')) return handlePutObject(event);
    if (method === 'DELETE' && path.startsWith('/objects/')) return handleDeleteObject(event);

    return json(404, { error: 'not_found', method, path });
  } catch (err) {
    console.error(err);   // full detail to CloudWatch only
    // Don't leak internal exception text (bucket names, key fragments, SDK internals) to clients.
    return json(500, { error: 'internal_error', requestId: event.requestContext?.requestId });
  }
};
