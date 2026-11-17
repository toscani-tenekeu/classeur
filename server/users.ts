import { readFileSync } from 'node:fs'
import { run } from './sys.ts'

export interface Account {
  name: string
  id: number
}

let cache: { at: number; users: Account[]; groups: Account[] } | null = null

function parse(text: string): Account[] {
  return text
    .split('\n')
    .map((line) => line.split(':'))
    .filter((parts) => parts.length >= 3 && parts[0])
    .map((parts) => ({ name: parts[0]!, id: Number(parts[2]) }))
    .filter((account) => Number.isInteger(account.id))
}

async function source(database: 'passwd' | 'group'): Promise<Account[]> {
  // getent also sees accounts from LDAP or SSSD; the files are the fallback.
  const result = await run(['getent', database], { timeout: 10_000 })
  if (result.ok && result.stdout.trim()) return parse(result.stdout)
  try {
    return parse(readFileSync(`/etc/${database}`, 'utf8'))
  } catch {
    return []
  }
}

export async function accounts() {
  if (cache && Date.now() - cache.at < 60_000) return cache
  const [users, groups] = await Promise.all([source('passwd'), source('group')])
  const byName = (a: Account, b: Account) => a.name.localeCompare(b.name)
  cache = { at: Date.now(), users: users.sort(byName), groups: groups.sort(byName) }
  return cache
}

export async function names() {
  const { users, groups } = await accounts()
  return {
    user: new Map(users.map((account) => [account.id, account.name])),
    group: new Map(groups.map((account) => [account.id, account.name])),
  }
}
