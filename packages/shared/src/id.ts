const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ENCODING_LEN = ENCODING.length;

export type IdPrefix =
  | "opr"
  | "ses"
  | "dev"
  | "stg"
  | "led"
  | "phn"
  | "seq"
  | "stp"
  | "enr"
  | "sch"
  | "out"
  | "msg"
  | "qkr"
  | "prc"
  | "acc"
  | "usr"
  | "pln"
  | "pay"
  | "aud";

let lastTime = 0;
let lastRandom: number[] = new Array(10).fill(0);

function getRandomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < count; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }
  return bytes;
}

export function generateUlid(prefix?: IdPrefix, timestampMs = Date.now()): string {
  // 10 characters of time (48 bits)
  let timeStr = "";
  let time = timestampMs;
  for (let i = 9; i >= 0; i--) {
    const mod = time % ENCODING_LEN;
    timeStr = ENCODING.charAt(mod) + timeStr;
    time = Math.floor(time / ENCODING_LEN);
  }

  // 16 characters of randomness (80 bits = 10 bytes)
  const randomBytes = getRandomBytes(10);
  let randomStr = "";
  for (let i = 0; i < 16; i++) {
    const randIndex = Math.floor(Math.random() * ENCODING_LEN);
    randomStr += ENCODING.charAt(randIndex);
  }

  const rawUlid = timeStr + randomStr;
  return prefix ? `${prefix}_${rawUlid}` : rawUlid;
}
