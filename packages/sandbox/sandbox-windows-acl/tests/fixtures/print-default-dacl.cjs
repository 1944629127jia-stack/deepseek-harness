/**
 * Confined-child fixture for runner.spec.ts: prints the current token's
 * default DACL as SDDL. Run ONLY as the windows-acl runner's confined child —
 * the assertion lives in the spec.
 */

const koffi = require('koffi')

const advapi32 = koffi.load('advapi32.dll')
const kernel32 = koffi.load('kernel32.dll')
const PVOID = koffi.pointer('void')
const PPVOID = koffi.pointer(PVOID)

const getCurrentProcess = kernel32.func('GetCurrentProcess', PVOID, [])
const openProcessToken = advapi32.func('OpenProcessToken', 'int', [PVOID, 'uint32', koffi.out(PPVOID)])
const getTokenInformation = advapi32.func('GetTokenInformation', 'int', [PVOID, 'int', PVOID, 'uint32', koffi.out(koffi.pointer('uint32'))])
const initializeSecurityDescriptor = advapi32.func('InitializeSecurityDescriptor', 'int', [PVOID, 'uint32'])
const setSecurityDescriptorDacl = advapi32.func('SetSecurityDescriptorDacl', 'int', [PVOID, 'int', PVOID, 'int'])
const convertSdToSddl = advapi32.func('ConvertSecurityDescriptorToStringSecurityDescriptorW', 'int', [PVOID, 'uint32', 'uint32', koffi.out(PPVOID), PVOID])

function toStr(ptr) {
  const arr = koffi.decode(ptr, 'int16', -1)
  let s = ''
  for (const c of arr) { if (c === 0) break; s += String.fromCharCode(c) }
  return s
}

const tokOut = [0]
if (openProcessToken(getCurrentProcess(), 0x8 /* TOKEN_QUERY */, tokOut) === 0) throw new Error('OpenProcessToken failed')
const lenOut = [0]
getTokenInformation(tokOut[0], 6 /* TokenDefaultDacl */, null, 0, lenOut)
const daclBuf = Buffer.alloc(lenOut[0])
if (getTokenInformation(tokOut[0], 6, daclBuf, daclBuf.length, lenOut) === 0) throw new Error('GetTokenInformation failed')
const sd = Buffer.alloc(64)
initializeSecurityDescriptor(sd, 1)
setSecurityDescriptorDacl(sd, 1, daclBuf.readBigUInt64LE(0), 0)
const sddlOut = [0]
if (convertSdToSddl(sd, 1, 0x4 /* DACL_SECURITY_INFORMATION */, sddlOut, null) === 0) throw new Error('ConvertSdToSddl failed')
process.stdout.write(`DEFAULT-DACL: ${toStr(sddlOut[0])}\n`)
