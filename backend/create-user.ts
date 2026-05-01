import dotenv from 'dotenv'
dotenv.config({ override: true })
import { createClient } from '@supabase/supabase-js'

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  
  // Create user with email confirmed and a temp password
  const { data, error } = await supabase.auth.admin.createUser({
    email: 'araderalex4@gmail.com',
    password: 'pinned-temp-2026',
    email_confirm: true,
  })
  
  if (error) {
    // Might already exist — try updating instead
    console.log('Create error:', error.message)
    const { data: list } = await supabase.auth.admin.listUsers()
    const existing = list?.users?.find(u => u.email === 'araderalex4@gmail.com')
    if (existing) {
      await supabase.auth.admin.updateUserById(existing.id, { password: 'pinned-temp-2026', email_confirm: true })
      console.log('Updated existing user:', existing.id)
    }
  } else {
    console.log('Created user:', data.user.id)
  }
  
  // Move any existing places to this user
  const { data: list } = await supabase.auth.admin.listUsers()
  const realUser = list?.users?.find(u => u.email === 'araderalex4@gmail.com')
  const testUser = list?.users?.find(u => u.email === 'test@pinned.app')
  
  if (realUser && testUser) {
    const { error: moveErr } = await supabase.from('places').update({ user_id: realUser.id }).eq('user_id', testUser.id)
    if (!moveErr) console.log('Moved places to real user')
  }
  
  console.log('Done. Sign in with: araderalex4@gmail.com / pinned-temp-2026')
}

main().catch(console.error)
