import { spawnSync } from 'node:child_process'
import { setPassword } from './auth.ts'

function ask(question: string): string {
  process.stdout.write(question)
  spawnSync('stty', ['-echo'], { stdio: 'inherit' })
  const answer = prompt('') ?? ''
  spawnSync('stty', ['echo'], { stdio: 'inherit' })
  process.stdout.write('\n')
  return answer
}

const command = process.argv[2]

if (command === 'passwd') {
  const password = ask('New password: ')
  if (password.length < 10) {
    console.error('Use a password of at least 10 characters.')
    process.exit(1)
  }
  if (ask('Repeat it: ') !== password) {
    console.error('The two passwords do not match.')
    process.exit(1)
  }
  await setPassword(password)
  console.log('Password saved. Everyone has been signed out.')
} else {
  console.log('Usage: bun server/cli.ts passwd')
  process.exit(command ? 1 : 0)
}
