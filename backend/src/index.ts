import dotenv from 'dotenv'
dotenv.config({ override: true })
import express from 'express'
import cors from 'cors'
import { requireAuth } from './middleware/auth'
import placesRouter from './routes/places'

const app = express()
const PORT = parseInt(process.env.PORT || '3000', 10)

app.use(cors())
app.use(express.json())

app.get('/health', (_req, res) => res.json({ status: 'ok' }))

// All /process routes require authentication
app.use(requireAuth)
app.use(placesRouter)

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Pinned backend running on port ${PORT}`)
})
