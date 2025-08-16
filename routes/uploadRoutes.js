// routes/uploadPresignedRoutes.js
import { minioClient } from '../services/minioClient.js'
import { randomUUID } from 'crypto'

export default async function uploadRoutes(fastify) {
  fastify.get('/presigned-url', async (req, reply) => {
    const { filename, mimetype } = req.query

    if (!filename || !mimetype) {
      return reply.code(400).send({ error: 'filename e mimetype são obrigatórios' })
    }

    const objectName = `uploads/${Date.now()}-${filename}`
    const bucketName = process.env.MINIO_BUCKET || 'uploads'

    try {
      const uploadUrl = await minioClient.presignedPutObject(bucketName, objectName, 300) // 5 min
      const publicUrl = `${process.env.MINIO_ENDPOINT}/${bucketName}/${objectName}`

      return reply.send({
        uploadUrl,
        publicUrl,
      })
    } catch (err) {
      fastify.log.error('[presigned-url] Erro ao gerar URL:', err)
      return reply.code(500).send({ error: 'Erro ao gerar URL de upload' })
    }
  })
}
