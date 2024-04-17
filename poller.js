'use strict';
/* jshint node: true */


var logger = require('nlogger').logger(module);
var net = require('net');
var udp = require('dgram');
var events = require('events');
var _ = require('underscore');
var async = require('async');
var geoip = require('geoip-lite');

var config = require('./config');
var protocol = require('./lib/protocol');


var emitter = new events.EventEmitter();

var colorCodePrefix = '\f';
function uncolorString(str)  {
  var i = str.indexOf(colorCodePrefix);
  if (i == -1) return str; // quick return if no color codes
  var filtered = '';
  while (i >= 0) {
    filtered = filtered + str.slice(0, i);
    str = str.slice(i + 2);
    i = str.indexOf(colorCodePrefix);
  }
  return filtered;
}

var colorCodePrefix = '\f';
function uncolorString(str)  {
  var i = str.indexOf(colorCodePrefix);
  if (i == -1) return str; // quick return if no color codes
  var filtered = '';
  i = str.indexOf(colorCodePrefix);
  while (i >= 0) {
    filtered = filtered + str.slice(0, i);
    str = str.slice(i + 2);
    i = str.indexOf(colorCodePrefix);
  }
  return filtered;
}

// replace this with 'uncolorString' at some point
var nameColorPrefix = '\fs\f';
var privatePrefix = "\f($";
function stripString(name, versionId)  {
  // strip colour codes
  var start;
  if (name.indexOf(nameColorPrefix) === 0) {
    start = name.indexOf(']') + 1;
    name = name.slice(start).slice(0, -2);
  }
  // strip private data (icons, etc.)
  if (name.indexOf(privatePrefix) === 0) {
    start = name.indexOf(']') + 1;
    name = name.slice(start);
  }
  return name;
}


function leftZeroPad(s, n) {
  while(s.length < n) {
    s = '0' + s;
  }
  return s;
}


var lastChecked = null;
var lastIdCounter = 0;
function processsServerReply(host, port, reply, batchId) {

  var report = {};

  var reported = new Date();
  var id = batchId + '_' + host + '_' + port;
  if (id == lastChecked) {
    lastIdCounter++;
  } else {
    lastIdCounter = 0;
  }
  lastChecked = id;
  id = id + '.' + leftZeroPad('' + lastIdCounter, 3);
  report._id = id;

  var stream = new protocol.Stream(reply, 5);

  report.host = host;
  report.port = port - 1;
  report.reported = reported.getTime();
  report.clients = stream.readNextInt();
  var count = stream.readNextInt();
  report.gameVersion = stream.readNextInt();
  count--;
  var versionName = 'unknown version (' + report.gameVersion + ')';
  var proto = null;
  if (report.gameVersion === 214) {
    versionName = 'OLD';
    proto = new protocol.Protocol214();
  } else if (report.gameVersion === 217) {
    proto = new protocol.Protocol217();
    versionName = '1.3';
  } else if (report.gameVersion === 220) {
    proto = new protocol.Protocol220();
    versionName = '1.4';
  } else if (report.gameVersion === 226) {
    proto = new protocol.Protocol226();
    versionName = '1.5';
  } else if (report.gameVersion === 245) {
    proto = new protocol.Protocol245();
    versionName = '1.5';
  } else {
    proto = new protocol.Protocol245();
    versionName = '';
  }
  var gameMode = stream.readNextInt();
  count--;
  report.gameMode = proto ? proto.gameModeFromCode(gameMode) : '???';
  var mutators = stream.readNextInt();
  count--;
  report.mutatorFlags = mutators;
  report.mutators = proto ? proto.mutatorsFromFlags(mutators, gameMode) : '???';
  var timeLeft = stream.readNextInt();
  if (report.gameVersion >= 278) {
    timeLeft = Math.floor(timeLeft / 1000); 
  }
  report.timeLeft = timeLeft;
  count--;
  report.maxClients = stream.readNextInt();
  count--;
  var masterMode = stream.readNextInt();
  report.masterMode = proto ? proto.masterModeFromCode(masterMode) : '???';
  count--;
  report.variableCount = stream.readNextInt();
  count--;
  report.modificationCount = stream.readNextInt();
  count--;
  if (report.gameVersion >= 226) {
    var majorVersion = stream.readNextInt();
    var minorVersion = stream.readNextInt();
    var patchVersion = stream.readNextInt();
    count = count - 3;
    versionName =
      '' + majorVersion + '.' + minorVersion + '.' + patchVersion;
  }
  while(count > 0) {
   stream.readNextInt();
   count--;
  }
  report.mapName = stream.readNextString();
  var serverName = uncolorString(stream.readNextString()) || (host + ':' + port);
  report.versionName = versionName;
  report.description = serverName;
  if (report.gameVersion >= 227) {
    report.versionbranch = stream.readNextString();
  }
  var playerNames = []; // kept for API backward compatibility
  var players = [];
  var rawName;
  var plainName;
  for (var i = 0; i < report.clients; i++) {
    rawName = stream.readNextString();
    plainName = stripString(rawName, report.gameVersion);
    var playerName = {
      raw : rawName,
      plain : plainName
    };
    playerNames.push(playerName);
    var player = {
      name: plainName,
      rawName: rawName
    };
    var parts = rawName.split('\f');
    if (parts.length > 3) {
      var privilegePart = parts[3].trim();
      var privilegeMatch = /\(\$priv([a-z]+)tex\)/.exec(privilegePart);
      if (privilegeMatch) {
        var privilege = privilegeMatch[1].trim();
        if (privilege) {
          player.privilege = privilege;
        }
      }
    }
    players.push(player);
  }
  report.playerNames = playerNames;
  report.players = players;

  if (report.gameVersion >= 226) {
      var authNames = [];
      for (var j = 0; j < report.clients; j++) {
        rawName = stream.readNextString();
        plainName = stripString(rawName, report.gameVersion);
        authNames.push({
          raw : rawName,
          plain : plainName
        });
      }
      report.authNames = authNames;
    }
  var geoipInfo = geoip.lookup(host);
  // sometimes this is null - maybe indicate outdated geoip DB
  if (geoipInfo) {
    report.country = geoip.lookup(host).country;
  }

  return report;
}


function startServerQuery(host, port, batchId, andThen) {
  logger.info('checking status of server: ', host, ':', port);
  var client = null;
  try {
    var query = new Buffer(5);
    query.writeUInt8(0x81, 0);
    query.writeUInt8(0xec, 1);
    query.writeUInt8(0x04, 2);
    query.writeUInt8(0x01, 3);
    query.writeUInt8(0x00, 4);
    client = udp.createSocket('udp4');
    client.on('message', function (reply) {
      client.close();
      client = null;
      try {
        logger.info('  .. procesing server reply for: ', host, ':', port);
        var report = processsServerReply(host, port, reply, batchId);
        logger.debug('report: ', JSON.stringify(report));
        emitter.emit('report', report);
        andThen();
      }  catch(err) {
        logger.warn('server reply processing failed: ', err);
        andThen();
      }
    });
    client.on('error', function (err) {
      client.close();
      client = null;
      logger.warn('server connection failed: ', err);
      andThen();
    });
    client.send(query, 0, query.length, port, host);
    // manually implement a UPD socket "timeout"
    var closeSocket = function() {
      if (client !== null) {
        logger.warn('server query timed out');
        client.close();
        client = null;
        andThen();
      }
    };
    setTimeout(closeSocket, 2000);
  } catch(err) {
    logger.warn('server query failed with uncaught error: ', err);
    if (client !== null) {
      client.close();
      client = null;
    }
    andThen();
  }
}


function pollMasterServer() {
  try {
    logger.info('polling master server');
    var client = net.connect(
      config.masterServer.port,
      config.masterServer.host,
      function() {
        logger.debug('polling socket connected');
      }
    );
    client.setEncoding('ascii');
    var allData = '';
    client.on('data', function(data) {
      allData = allData + data;
    });
    client.on('error', function(err) {
      logger.error('master server may be down');
    });
    client.on('end', function() {
      logger.debug('polling socket closed normally');
      var servers = [];
      var lines = allData.split('\n');
      _.each(lines, function(line) {
        if (line.indexOf('addserver ') === 0) {
          var parts = line.split(' ');
          servers.push([parts[1], parseInt(parts[2])]);
        }
      });
      logger.info('found servers: ', servers.length);
      var batchId = (new Date()).toISOString();
      async.forEachSeries(
        servers,
        function(server, andThen) {
          startServerQuery(server[0], server[1] + 1, batchId, andThen);
        },
        function(err) {
          if (err) {
            logger.error('while checking servers: ', err);
          } else {
            logger.info('servers checked');
          }
        }
      );
    });
    client.write('update\n');
  } catch (err) {
    logger.error('while polling master server: ', err);
  }
}


function startPollingMasterServer() {
  pollMasterServer();
  setInterval(pollMasterServer, config.pollingInterval*1000);
}


if (typeof exports == 'object') {
  exports.startPollingMasterServer = startPollingMasterServer;
  exports.emitter = emitter;
}
