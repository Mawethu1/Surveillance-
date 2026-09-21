// Including libraries

var http = require('http');
var fs = require('fs');
var path = require('path');
const static = require('node-static'); // for serving files

var fileServer = new static.Server('./');
var dataDir = path.join(__dirname, 'HumanData');

function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
  }
}

function sanitizeFileName(value) {
  return String(value || 'unknown').trim().replace(/[^a-z0-9_-]/gi, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}

function writeProfile(profile) {
  ensureDataDir();

  var safeName = sanitizeFileName(profile.name);
  var filePath = path.join(dataDir, safeName + '.json');
  fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf8');
  return filePath;
}

function readAllProfiles() {
  ensureDataDir();

  return fs.readdirSync(dataDir)
    .filter(function(fileName) {
      return fileName.toLowerCase().endsWith('.json');
    })
    .map(function(fileName) {
      var filePath = path.join(dataDir, fileName);
      var rawData = fs.readFileSync(filePath, 'utf8');

      try {
        return JSON.parse(rawData);
      } catch (err) {
        console.warn('MotionDetection: failed to parse profile file.', fileName, err);
        return null;
      }
    })
    .filter(Boolean);
}

function deleteProfile(name) {
  ensureDataDir();

  var safeName = sanitizeFileName(name);
  var filePath = path.join(dataDir, safeName + '.json');

  if (!fs.existsSync(filePath)) {
    return false;
  }

  fs.unlinkSync(filePath);
  return true;
}

function parseRequestUrl(req) {
  return new URL(req.url, 'http://localhost');
}

function sendJson(res, payload, statusCode) {
  res.writeHead(statusCode || 200, {
    'Content-Type': 'application/json'
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise(function(resolve, reject) {
    var body = '';

    req.on('data', function(chunk) {
      body += chunk;
    });

    req.on('end', function() {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });

    req.on('error', reject);
  });
}

http.createServer((req, res) => {
  var requestUrl = parseRequestUrl(req);

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');

  if (requestUrl.pathname === '/api/human-data' && req.method === 'GET') {
    sendJson(res, readAllProfiles());
    return;
  }

  if (requestUrl.pathname === '/api/human-data' && req.method === 'POST') {
    readBody(req).then(function(profile) {
      if (!profile || !profile.name || !Array.isArray(profile.descriptor)) {
        sendJson(res, { error: 'Invalid profile payload.' }, 400);
        return;
      }

      writeProfile(profile);
      sendJson(res, { success: true, profile: profile });
    }).catch(function(err) {
      console.warn('MotionDetection: failed to save profile.', err);
      sendJson(res, { error: 'Unable to save profile.' }, 500);
    });
    return;
  }

  if (requestUrl.pathname === '/api/human-data' && req.method === 'DELETE') {
    var deleteName = requestUrl.searchParams.get('name');

    if (!deleteName) {
      sendJson(res, { error: 'Missing profile name.' }, 400);
      return;
    }

    if (!deleteProfile(deleteName)) {
      sendJson(res, { error: 'Profile not found.' }, 404);
      return;
    }

    sendJson(res, { success: true, deleted: true, name: deleteName });
    return;
  }

  req.addListener('end', function () {
    fileServer.serve(req, res);
  }).resume();
}).listen(7777);