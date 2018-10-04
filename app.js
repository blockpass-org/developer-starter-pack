const express = require('express')
const bodyParser = require('body-parser')
const cors = require('cors')
const multer = require('multer')
const ServerSDK = require('bp-sdk-server')
const { KYCModel, FileStorage } = require('./SimpleStorage')

const config = {
  BASE_URL: 'https://sandbox-api.blockpass.org',
  BLOCKPASS_CLIENT_ID: 'developer_service',
  BLOCKPASS_SECRET_ID: 'developer_service'
}

// -------------------------------------------------------------------------
//  Logic Handler
// -------------------------------------------------------------------------
async function findKycById(kycId) {
  return await KYCModel.findOne({ blockPassID: kycId })
}

async function createKyc({ kycProfile, refId }) {
  const { id, smartContractId, rootHash, isSynching } = kycProfile
  const newIns = new KYCModel({
    blockPassID: id,
    refId,
    rootHash,
    smartContractId,
    isSynching
  })

  newIns.certs = serverSdk.certs.reduce((acc, key) => {
    acc[key] = {
      slug: key,
      status: 'missing'
    }
    return acc
  }, {})

  newIns.identities = serverSdk.requiredFields.reduce((acc, key) => {
    acc[key] = {
      slug: key,
      status: 'missing'
    }
    return acc
  }, {})

  return await newIns.save()
}

async function updateKyc({ kycRecord, kycProfile, kycToken, userRawData }) {
  const { id, smartContractId, rootHash, isSynching } = kycProfile

  const jobs = Object.keys(userRawData).map(async key => {
    const metaData = userRawData[key]

    if (metaData.type === 'string') {
      if (metaData.isCert) {
        return (kycRecord.certs[key] = {
          slug: key,
          value: metaData.value,
          status: 'received',
          comment: ''
        })
      } else {
        return (kycRecord.identities[key] = {
          slug: key,
          value: metaData.value,
          status: 'received',
          comment: ''
        })
      }
    }

    const { buffer, originalname } = metaData
    const ext = originalname.split('.')[1]
    const fileName = `${id}_${key}.${ext}`
    const fileHandler = await FileStorage.writeFile({
      fileName,
      mimetype: `image/${ext}`,
      fileBuffer: buffer
    })

    return (kycRecord.identities[key] = {
      slug: key,
      value: fileHandler._id,
      isFile: true,
      status: 'received',
      comment: ''
    })
  })

  await Promise.all(jobs)

  // calculate token expired date from 'expires_in'
  const expiredDate = new Date(Date.now() + kycToken.expires_in * 1000)
  kycRecord.bpToken = {
    ...kycToken,
    expires_at: expiredDate
  }

  kycRecord.status = 'inreview'
  kycRecord.rootHash = rootHash
  kycRecord.smartContractId = smartContractId
  kycRecord.isSynching = isSynching

  return await kycRecord.save()
}

async function generateSsoPayload({
  kycProfile,
  kycRecord,
  kycToken,
  payload
}) {
  return {
    _id: kycRecord._id
  }
}

async function queryKycStatus({ kycRecord }) {
  const { status, identities, certs } = kycRecord

  // status meaning:
  //  - "received": data recieved by service and under review
  //  - "approved": data fields approved by service
  //  - "rejected": data rejected by service. Please provide comments for this
  //     => Mobile app will asking user to update
  //  - "missing": data fields missing - Uploading error
  //     => Mobile app will asking user to re-upload
  const identitiesStatus = Object.keys(identities).map(key => {
    const itm = identities[key]
    const { slug, status, comment } = itm
    return {
      slug,
      status,
      comment
    }
  })

  const certsStatus = Object.keys(certs).map(key => {
    const itm = certs[key]
    const { slug, status } = itm
    return {
      slug,
      status
    }
  })

  return {
    status,
    message: 'This process usually take 2 working days',
    createdDate: new Date(),
    identities: identitiesStatus,
    certificates: certsStatus,
    allowResubmit: true
  }
}

// -------------------------------------------------------------------------
// Express app
// -------------------------------------------------------------------------
const app = express()
const upload = multer()

// Allow access origin
app.use(cors({}))
app.disable('x-powered-by')

// middleware
app.use(bodyParser.json()) // for parsing application/json
app.use(bodyParser.urlencoded({ extended: true })) // for parsing application/x-www-form-urlencoded

const router = express.Router()
app.use(router)

router.get('/', (req, res) => {
  res.json('hello')
})

// -------------------------------------------------------------------------
// Api
// -------------------------------------------------------------------------
router.post('/blockpass/api/uploadData', upload.any(), async (req, res) => {
  try {
    const { accessToken, slugList, ...userRawFields } = req.body
    const files = req.files || []

    // Flattern user data
    const userRawData = {}

    Object.keys(userRawFields).forEach(key => {
      const originalKey = key
      const isCert = key.startsWith('[cer]')
      if (isCert) key = key.slice('[cer]'.length)

      userRawData[key] = {
        type: 'string',
        value: userRawFields[originalKey],
        isCert
      }
    })

    files.forEach(itm => {
      userRawData[itm.fieldname] = {
        type: 'file',
        ...itm
      }
    })

    const payload = await serverSdk.updateDataFlow({
      accessToken,
      slugList,
      ...userRawData
    })
    return res.json(payload)
  } catch (ex) {
    console.error(ex)
    return res.status(500).json({
      err: 500,
      msg: ex.message
    })
  }
})

// -------------------------------------------------------------------------
router.post('/blockpass/api/login', async (req, res) => {
  try {
    const { code, sessionCode, refId } = req.body

    const payload = await serverSdk.loginFow({ code, sessionCode, refId })
    return res.json(payload)
  } catch (ex) {
    console.error(ex)
    return res.status(500).json({
      err: 500,
      msg: ex.message
    })
  }
})

// -------------------------------------------------------------------------
router.post('/blockpass/api/register', async (req, res) => {
  try {
    const { code, refId } = req.body

    const payload = await serverSdk.registerFlow({ code, refId })
    return res.json(payload)
  } catch (ex) {
    console.error(ex)
    return res.status(500).json({
      err: 500,
      msg: ex.message
    })
  }
})

// -------------------------------------------------------------------------
router.post('/blockpass/api/resubmit', async (req, res) => {
  try {
    const { code, fieldList, certList } = req.body

    const payload = await serverSdk.resubmitDataFlow({
      code,
      fieldList,
      certList
    })
    return res.json(payload)
  } catch (ex) {
    console.error(ex)
    return res.status(500).json({
      err: 500,
      msg: ex.message
    })
  }
})

// -------------------------------------------------------------------------
router.post('/blockpass/api/status', async (req, res) => {
  try {
    const { code, sessionCode } = req.body

    const payload = await serverSdk.queryStatusFlow({ code, sessionCode })
    return res.json(payload)
  } catch (ex) {
    console.error(ex)
    return res.status(500).json({
      err: 500,
      msg: ex.message
    })
  }
})

// -------------------------------------------------------------------------
router.post('/util/sendPn', async (req, res) => {
  try {
    const { bpId, title = 'title', message = 'body' } = req.body

    if (!bpId) {
      return res.status(400).json({
        err: 400,
        msg: 'Missing blockpass Id'
      })
    }

    const kycRecord = await KYCModel.findOne({ blockPassID: bpId })

    if (!kycRecord) {
      return res.status(404).json({
        err: 404,
        msg: 'kycRecord not found'
      })
    }

    const response = await serverSdk.userNotify({
      title,
      message,
      bpToken: kycRecord.bpToken
    })

    const { bpToken } = response

    // update refreshed Token
    if (bpToken !== kycRecord.bpToken) {
      kycRecord.bpToken = bpToken
      await kycRecord.save()
    }

    return res.json(response.res)
  } catch (ex) {
    console.error(ex)
    return res.status(500).json({
      err: 500,
      msg: ex.message
    })
  }
})

// -------------------------------------------------------------------------
//  Blockpass Server SDK
// -------------------------------------------------------------------------
const serverSdk = new ServerSDK({
  baseUrl: config.BASE_URL,
  clientId: config.BLOCKPASS_CLIENT_ID,
  secretId: config.BLOCKPASS_SECRET_ID,
  autoFetchMetadata: true,

  // Custom implement
  findKycById: findKycById,
  createKyc: createKyc,
  updateKyc: updateKyc,
  queryKycStatus: queryKycStatus,
  generateSsoPayload: generateSsoPayload
})

// Sdk loaded
serverSdk.once('onLoaded', _ => {
  const port = process.env.SERVER_PORT || 3000
  let server = app.listen(port, '0.0.0.0', function() {
    console.log(`Listening on port ${port}...`)
  })

  // gracefull shutdown
  app.close = _ => server.close()
})

// Sdk error
serverSdk.once('onError', err => {
  console.error(err)
  process.exit(1)
})

module.exports = app
