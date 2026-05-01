import { Request, Response, NextFunction } from 'express'
import { createClient } from '@supabase/supabase-js'

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ message: 'Missing authorization header' })
    return
  }

  const token = authHeader.slice(7)

  // Verify token against Supabase
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_ANON_KEY!
  )

  const { data: { user }, error } = await supabase.auth.getUser(token)

  if (error || !user) {
    res.status(401).json({ message: 'Invalid or expired token' })
    return
  }

  ;(req as any).userId = user.id
  next()
}
