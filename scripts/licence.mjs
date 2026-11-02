// Makes the licence key pair and signs licence keys, offline.
//
//   node scripts/licence.mjs keygen <private-key.pem>
//       Writes a new Ed25519 private key (keep it secret, out of this repo) and prints the public key to paste
//       into PUBLIC_KEY in src/main/licence.ts.
//   node scripts/licence.mjs issue <private-key.pem> --name "Ada Lovelace" --email ada@example.com [--edition personal]
//       Prints a licence key for one buyer.
import crypto from 'node:crypto'
import fs from 'node:fs'

const PREFIX = 'SI1'
const [command, file, ...rest] = process.argv.slice(2)
const flag = name => {
  const i = rest.indexOf(`--${name}`)
  return i >= 0 ? rest[i + 1] : undefined
}

if (command === 'keygen' && file) {
  if (fs.existsSync(file)) throw new Error(`${file} exists; not overwriting it.`)
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  fs.writeFileSync(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  console.log(`Private key written to ${file}. Public key for src/main/licence.ts:\n`)
  console.log(publicKey.export({ type: 'spki', format: 'pem' }))
} else if (command === 'issue' && file && flag('name') && flag('email')) {
  const licence = { name: flag('name'), email: flag('email'), issued: new Date().toISOString().slice(0, 10), edition: flag('edition') ?? 'personal' }
  const body = Buffer.from(JSON.stringify(licence)).toString('base64url')
  const signature = crypto.sign(null, Buffer.from(`${PREFIX}.${body}`), crypto.createPrivateKey(fs.readFileSync(file)))
  console.log(`${PREFIX}.${body}.${signature.toString('base64url')}`)
} else {
  console.log('Usage:\n  node scripts/licence.mjs keygen <private-key.pem>\n  node scripts/licence.mjs issue <private-key.pem> --name "…" --email … [--edition personal]')
  process.exitCode = 1
}
