#!/usr/bin/env node

/**
 * simple check that tokens exist via action inputs
 */

const token = process.env.INPUT_TOKEN;
const anthropicKey = process.env.INPUT_ANTHROPIC_KEY;
let failed = false;

console.log("checking token input...");
if (token) {
  console.log(`token exists, prefix: ${token.substring(0, 10)}...`);
} else {
  console.error("token input is empty");
  console.log("::error::token input is empty");
  failed = true;
}

console.log("checking anthropic_key input...");
if (anthropicKey) {
  console.log(`anthropic_key exists, prefix: ${anthropicKey.substring(0, 10)}...`);
} else {
  console.error("anthropic_key input is empty");
  console.log("::error::anthropic_key input is empty");
  failed = true;
}

if (failed) {
  process.exit(1);
}

console.log("all inputs present");
