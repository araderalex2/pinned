import dotenv from 'dotenv'
dotenv.config({ override: true })
import { createClient } from '@supabase/supabase-js'

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  const result = await supabase.auth.admin.listUsers()
  console.log('error:', result.error?.message)
  console.log('users count:', result.data?.users?.length)
  if (result.data?.users?.length) {
    console.log('first user id:', result.data.users[0].id)
    console.log('first user email:', result.data.users[0].email)
  }
}
main().catch(console.error)
