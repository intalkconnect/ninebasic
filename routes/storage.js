// routes/uploadPresignedRoutes.js (R2, sem headers extras na assinatura)
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'crypto'

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID
const R2_BUCKET = process.env.R2_BUCKET

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
  },
})

function sanitizeFilename(name = '') {
  return String(name).replace(/[^\w.\-]+/g, '_')
}

export default async function storageRoutes(fastify) {
  fastify.get('/presigned-url', async (req, reply) => {
    const { filename, mimetype } = req.query || {}
    if (!filename || !mimetype) {
      return reply.code(400).send({ error: 'filename e mimetype são obrigatórios' })
    }

    const safeName = sanitizeFilename(filename)
    const objectKey = `uploads/${Date.now()}-${randomUUID()}-${safeName}`

    try {
      // ⚠️ Assine APENAS com ContentType (o front já envia esse header)
      const putCmd = new PutObjectCommand({
        Bucket: R2_BUCKET,
        Key: objectKey,
        ContentType: mimetype
      })

      const uploadUrl = await getSignedUrl(s3, putCmd, { expiresIn: 300 }) // 5 min

      const publicBase = (process.env.R2_PUBLIC_BASE || '').replace(/\/$/, '')
      if (!publicBase) {
        return reply.code(500).send({
          error: 'Defina R2_PUBLIC_BASE no .env para gerar publicUrl acessível'
        })
      }
      const publicUrl = `${publicBase}/${objectKey}`

      return reply.send({ uploadUrl, publicUrl })
    } catch (err) {
      fastify.log.error('[presigned-url:R2] erro:', err)
      return reply.code(500).send({ error: 'Erro ao gerar URL de upload' })
    }
  })
}
