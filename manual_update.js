'use strict'

var fs = require('fs')
var path = require('path')
var _ = require('lodash')

var codeRoot = __dirname
var DEVICE_CONFIG_PATH = path.resolve(codeRoot, 'device_config.json')

var deviceConfig = JSON.parse(fs.readFileSync(DEVICE_CONFIG_PATH))

var config = deviceConfig.updater.extractor

config.skipVerify = true
var extractor = require(codeRoot + '/lib/update/extractor').factory(config)

var fileInfo = {
  rootPath: '/opt/lamassu-updates/extract',
  filePath: '/opt/lamassu-updates/download/update.tar'
}

function triggerWatchdog (cb) {
  var donePath = '/opt/lamassu-updates/extract/done.txt'
  fs.writeFile(donePath, 'DONE\n', null, function (err) {
    if (err) throw err
    console.log('watchdog triggered')
    cb()
  })
}

process.on('SIGTERM', function () {
  // Immune
})

extractor.extract(fileInfo, function (err) {
  console.log('extracting...')
  if (err) throw err
  triggerWatchdog(function () { console.log('all done.') })
})
