/* README

# MyCRUD

The goal of this project is to create a simple CRUD backend / key-value store, for unhosted JavaScript applications, which can be installed in existing WordPress or node applications.

- node.js implementation - using level as storage, integrates with facebook/google/... logins
- WordPress installable plugin, - no extra servers needed.
- Per user quota

Initial version implemented as part of ByHax.

Later on: levelup compatibility

# API

Initial

```
GET /:owner/:db/:key
GET /:owner/:db?since=...[&keys=false][&values=false][&version=false]
GET /:owner/:db?gt=...[&limit=...][&lt=...][&keys=false][&values=false][&version=false]
```

Manual put by tinkuy.

Later on:
```
PUT /:owner/:db/:key[?version=...]
GET / * /:db/:key[?limit=...][&before=...][&since=...][&values=false][&version=false][&owner=false]
GET / * /:db?gt=...[&limit=...][&lt=...][&keys=false][&values=false][&version=false][&owner=false]
DELETE /:owner/:db/:key[?version=...]
```
- quota
- private databases, starting with underscore, only readable by owner
- PUT only by owner
- DELETE only by owner or admin

# LevelDB implementation notes

- versionIndex:
    - `:owner/:db/:key` -> `version` + `value`
    - `:owner/:db/:version` -> `:key`

# SQL Implementation notes

- table
    - owner VARCHAR(255)
    - db VARCHAR(255)
    - key VARCHAR(255)
    - version LONGINT millisecond timestamp
    - value
- indices
    - primary unique index: owner, namespace, key
    - unique index: namespace, key, version (owner)

Namespaces starting with `_` are private, i.e. only user can read owned values, the rest are public, i.e. everybody can read.

Quota per owner, `ns=_quota&owner=admin&key=$USER` contains json with quota (and namespace blacklist). `ns=_quota&owner=admin&key=admin` contains default quota in default field.
Quota object includes info on current usage.


## old api notes
API:
- PUT/POST
    - ns (required)
    - key (required)
    - value (required) (body)
    - version (optional - transactional if present - must equal previous version) Version is alway update to current ms-time, and will delay/make sure it is incremented.
    - multi (optional) allow multiple versions for same key
- DELETE
    - owner (only by admin)
    - ns (required)
    - key (required)
    - version (optional - transactional if present - must equal previous version)
- GET returns `namespace\0owner\0key\0version-timestamp\0value` value may include `\0`
    - owner (optional)
    - ns (required, optional if prev/next)
    - key (required, optional if prev/next)
    - version (optional)
    - prev/next (optional, possible values: "version", "any") the next entry before/after given version/key/..., instead of matching key/version
- GET `meta=true` - returns owner-id + quota info

## Later 

Groups

Later: Authorized CORS configuration whitelist: `ns=_cors&owner=user&key=$DOMAIN`. Forbidden / redirect user to allow access to namespaces from domain.
- Later: GET `cors=request&domain=...` ask user to confirm access
- Later: GET `cors=confirm&token=...` send when user confirmed

maybe remotestorage.io compatibility

*/
//
const assert = require('assert');
const express = require('express');
const level = require('level');
const router = express.Router();

// TODO make encoding be ascii (it is utf-8 by default, but we want to store json and 8bit-blobs)
const dataPath = './_';

// owner,db,key -> version,value
const mcData = level(dataPath + 'mycrudData.leveldb');

// owner,db,version -> key
const mcVersion = level(dataPath + 'mycrudVersion.leveldb');

async function getOr(mc, key, defaultValue) {
  try {
    return await mc.get(key);
  } catch (e) {
    return defaultValue;
  }
}
async function getVersionData(owner, db, key) {
  const path = [owner, db, key].join('/');
  const value = await getOr(mcData, path, '');
  return [value.slice(0, 24), value.slice(24)];
}
async function get(owner, db, key, defaultValue) {
  let [version, data] = await getVersionData(owner, db, key);
  if (!version) {
    if (arguments.length < 4) {
      throw new Error('not found');
    } else {
      data = defaultValue;
    }
  }
  return {version, data};
}
let globalVersion;
let putLocked = false;
async function put(owner, db, key, value, opt) {
  opt = opt || {};
  const version = opt.version;

  // one put at a time to avoid race conditions, and
  // rate limit to one put per ms, to ensure unique timestamps
  let newVersion = new Date().toISOString();
  while (putLocked || newVersion === globalVersion) {
    await new Promise(resolve => setTimeout(resolve, 1));
    newVersion = new Date().toISOString();
  }
  globalVersion = newVersion;
  putLocked = true;

  try {
    const [prevVersion] = await getVersionData(owner, db, key);
    const promises = [];

    // Detect conflicts
    if (version && version !== prevVersion) {
      throw new Error('conflict');
    }

    // Update version index
    if (prevVersion) {
      promises.push(mcVersion.del([owner, db, prevVersion].join('/')));
    }
    promises.push(
      mcVersion.put([owner, db, newVersion].join('/'), key)
    );

    // Put value
    promises.push(
      mcData.put([owner, db, key].join('/'), newVersion + value)
    );

    await Promise.all(promises);
    putLocked = false;
  } catch (e) {
    putLocked = false;
    throw e;
  }
}

router.get('/', (req, res) => {
  res.send('mycrud 0.0.1');
});
router.get('/:owner/:db/:key', async (req, res) => {
  const {owner, db, key} = req.params;
  try {
    const {version, data} = await get(owner, db, key);
    res.set('ETag', `"${version}"`);
    res.set('Content-Type', 'application/octet-stream');
    res.send(Buffer.from(data, 'latin1'));
  } catch (e) {
    res.status(404).send('not found');
  }
});

async function getRange({res, query, owner, db}) {
  res.set('Content-Type', 'text/plain;charset=latin1');
  const lt = [owner, db, query.lt].join('/');
  const gt = [owner, db, query.gt].join('/');
  const dbNameLength = owner.length + db.length + 2;
  const stream = mcData
    .createReadStream({lt, gt})
    .on('data', data => {
      stream.pause();
      res.write(
        Buffer.from(
          JSON.stringify({
            key: data.key.slice(dbNameLength),
            version: data.value.slice(0, 24),
            value: data.value.slice(24)
          }) + '\n',
          'latin1'
        ),
        err => (err ? stream.destroy() : stream.resume())
      );
    })
    .on('error', e => res.send('ERROR: ' + String(e)))
    .on('end', () => res.end());
}

async function getSince({res, db, owner, query}) {
  res.set('Content-Type', 'application/json');
  const ownerDb = `${owner}/${db}/`;
  const gt = ownerDb + query.since;
  const lt = ownerDb.slice(0, -1) + '0';
  const dbNameLength = owner.length + db.length + 2;
  let done = false;
  let writing = false;
  let keys = [];
  const stream = mcVersion
    .createReadStream({lt, gt})
    .on('data', async data => {
      keys.push(data.value);
    })
    .on('error', e => {
      console.log(e);
      res.status(500).send('an error occurred');
    })
    .on('end', () => {
      res.json(keys);
    });
}

router.get('/:owner/:db', async (req, res) => {
  const query = req.query;
  const {owner, db} = req.params;
  if (query.gt && query.lt) {
    return getRange({query, owner, db, res});
  }
  if (query.since) {
    return getSince({query, owner, db, res});
  }
  res.status(400).send('needs lt and gt query parameters');
});

module.exports = {router, put, get};
