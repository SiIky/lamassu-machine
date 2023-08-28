const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const _ = require('lodash/fp')
const Pdf417Parser = require('./compliance/parsepdf417')
const { utils: coinUtils } = require('@lamassu/coins')
const cameraStreamer = require('./camera-streamer')
const network = require('minimist')(process.argv.slice(2)).network || 'main'

const selectedCamResolutions = {}

let configuration = null
let kogoroshiya = null
let DEFAULT_FPS = 10

const maxCamResolutions = [
  {
    width: 2592,
    height: 1944
  }
]

const minCamResolutions = [
  {
    width: 1280,
    height: 1024
  },
  {
    width: 1280,
    height: 960
  },
  {
    width: 1280,
    height: 720
  },
  {
    width: 640,
    height: 480
  }
]

const maxCamResolutionQRCode = [
  {
    width: 640,
    height: 480
  }
]

const maxCamResolutionPhotoId = [
  {
    width: 1280,
    height: 1024
  }
]

const mode2conf = mode =>
  mode === 'facephoto' ? 'frontFacingCamera' : 'scanner'
const getCameraDevice = mode =>
  _.get([mode2conf(mode), 'device'], configuration)
const getCameraConfig = mode =>
  _.get([mode2conf(mode), mode], configuration)

const setDefaultFPS = fps => { DEFAULT_FPS = fps }

function setConfig (formats, mode) {
  const isQRCodeMode = mode === 'qr'
  const isPhotoIdMode = mode === 'photoId'

  let format = selectedCamResolutions[mode]
  if (!_.isNil(format)) return format

  const pixelRes = format => format.width * format.height
  const isSuitableRes = res => {
    const currentRes = pixelRes(res)

    const isAboveMinAcceptableResolutions = _.some(_.flow(pixelRes, _.gte(currentRes)))
    const isUnderMaxAcceptableResolutions = _.some(_.flow(pixelRes, _.lte(currentRes)))

    const maxResolutions = isQRCodeMode ? maxCamResolutionQRCode :
      isPhotoIdMode ? maxCamResolutionPhotoId :
      maxCamResolutions
    return isUnderMaxAcceptableResolutions(maxResolutions) &&
     isAboveMinAcceptableResolutions(minCamResolutions)
  }

  selectedCamResolutions[mode] = format = _.flow(
    _.filter(f => f.format === 'Motion-JPEG'),
    _.orderBy(pixelRes, ['desc']),
    _.find(isSuitableRes),
  )(formats)

  if (!format) throw new Error('Unsupported cam resolution!')
  return format
}

const pickFormat = mode => formats => setConfig(formats, mode)

function config (_configuration) {
  configuration = _configuration
}

const isCancelledError = err => err.cancelled
const isAbortError = err => err.name === 'AbortError'
const shouldIgnoreError = err => isCancelledError(err) || isAbortError(err)

const clear_kogoroshiya = () => {
  kogoroshiya = null
}

const replace_kogoroshiya = (atarashii_kogoroshiya) => {
  if (kogoroshiya) kogoroshiya.abort()
  kogoroshiya = atarashii_kogoroshiya
}

const cancel = () => {
  replace_kogoroshiya(null)
  return false
}

const isOpened = () => !!kogoroshiya

const hasCamera = mode => {
  const device = getCameraDevice(mode)
  return device ? cameraStreamer.hasCamera(device) : Promise.resolve(false)
}

const scanQR = callback => {
  const [korose, promise] = cameraStreamer.scanQR(getCameraDevice('qr'), pickFormat('qr'), DEFAULT_FPS)
  replace_kogoroshiya(korose)
  promise
    .then(result => {
      clear_kogoroshiya()
      callback(null, result ? result.toString() : result)
    })
    .catch(error => {
      clear_kogoroshiya()
      shouldIgnoreError(error) ? callback(null, null) : callback(error, null)
    })
}

const scanPDF417 = (callback, idCardStillsCallback) => {
  const rmrf = dir =>
    fs.rm(dir, { force: true, recursive: true, maxRetries: 5 })
      .catch(err => console.debug("Error removing failed scans directory (", dir, "): ", err))

  /* NOTE: idCardStillsCallback() MUST NOT reject */
  const saveFailedScans = dirs => idCardStillsCallback(dirs).then(() => Promise.all(_.map(rmrf, dirs)))

  const mode = 'photoId'
  const device = getCameraDevice(mode)
  const pickfmt = pickFormat(mode)

  const resolveScan = (tmpdirs, promise) =>
    promise
      .then(result => {
        clear_kogoroshiya()
        return result
      })
      .then(result => Promise.all([
        result,
        Pdf417Parser.parse(result),
        saveFailedScans(tmpdirs)
      ]))
      .then(([result, parsed, _]) => {
        parsed = parsed || null
        if (parsed) parsed.raw = result.toString()
        callback(null, parsed)
      })
      .catch(err => {
        clear_kogoroshiya()
        saveFailedScans(tmpdirs)
          .then(() => shouldIgnoreError(err) ? callback(null, null) : callback(err, null))
      })

  fs.mkdtemp(path.join(os.tmpdir(), 'failed-scans-'))
    .catch(err => {
      console.error(err)
      return null /* cameraStreamer.scanPDF417() ignores the tmpdir if null */
    })
    .then(tmpdir => {
      const tmpdirs = tmpdir ? [tmpdir] : []
      const [korose, promise] = cameraStreamer.scanPDF417(device, pickfmt, DEFAULT_FPS, tmpdir)
      replace_kogoroshiya(korose)
      return resolveScan(tmpdirs, promise)
    })
}

const detectFace = (mode, minsizeDef, cutoffDef, callback) => {
  const device = getCameraDevice(mode)
  const modeConfig = getCameraConfig(mode)
  const minsize = modeConfig.minFaceSize || minsizeDef
  const cutoff = modeConfig.threshold || cutoffDef
  const [korose, promise] = cameraStreamer.detectFace(device, pickFormat(mode), DEFAULT_FPS, minsize, cutoff)
  replace_kogoroshiya(korose)
  promise
    .then(frame => {
      clear_kogoroshiya()
      callback(null, frame)
    })
    .catch(error => {
      clear_kogoroshiya()
      shouldIgnoreError(error) ? callback(null, null) : callback(error, null)
    })
}

const scanPhoto = callback => detectFace('photoId', 100, 20, callback)
const scanFacephoto = callback => detectFace('facephoto', 100, 20, callback)

const scanFacephotoTC = scanFacephoto

const scanPairingCode = callback =>
  scanQR((err, res) =>
    err ? callback(err) :
    !res ? callback(null, null) :
    callback(null, res)
  )

const scanMainQR = (cryptoCode, callback) =>
  scanQR((err, result) => {
    if (err) return callback(err)
    if (!result) return callback(null, null)

    console.log('DEBUG55: %s', result)

    try {
      callback(null, coinUtils.parseUrl(cryptoCode, network, result))
    } catch (error) {
      callback(error)
    }
  })

const scanPK = scanPairingCode

const scanPhotoCard = callback =>
  scanPhoto((err, frame) =>
    err ? callback(err) :
    !frame ? callback(null, null) : /* Shouldn't happen */
    callback(null, frame)
  )

const takeFacephoto = callback =>
  scanFacephoto((err, frame) =>
    err ? callback(err) :
    !frame ? callback(null, null) : /* Shouldn't happen */
    callback(null, frame)
  )

const takeFacePhotoTC = callback =>
  scanFacephotoTC((err, frame) =>
    err ? callback(err) :
    !frame ? callback(null, null) : /* Shouldn't happen */
    callback(null, frame)
  )

module.exports = {
  config,
  setDefaultFPS,
  scanPairingCode,
  scanMainQR,
  scanPDF417,
  scanPhotoCard,
  takeFacephoto,
  cancel,
  isOpened,
  scanPK,
  hasCamera,
  takeFacePhotoTC
}
