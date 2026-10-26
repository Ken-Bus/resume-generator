// Input-size arithmetic shared by the AI endpoints.
//
// AI Polish and Tailor send the whole resume back, so the reply is about as long as the request. If the reply cannot fit in the
// output cap (max_tokens) the call is certain to be cut off: the customer gets an error AND the provider bills for the tokens. Checking
// the size before the call turns that into a free, instant "too long" message. The ratio is deliberately on the cautious side
// (Sonnet 5.5's tokenizer gives about 2.8 characters per token for JSON; this assumes 2.6) and is for the pre-check only.
const OUTPUT_TOKENS_PER_JSON_CHAR = 0.385;
const FIT = 0.92;                                       // leave headroom: never plan to use the last 8% of the cap

const estimateOutputTokens = (jsonChars) => Math.ceil(jsonChars * OUTPUT_TOKENS_PER_JSON_CHAR);
const fitsOutput = (jsonChars, maxTokens) => estimateOutputTokens(jsonChars) <= Math.floor(maxTokens * FIT);
const maxJsonChars = (maxTokens) => Math.floor((maxTokens * FIT) / OUTPUT_TOKENS_PER_JSON_CHAR);

module.exports = { estimateOutputTokens, fitsOutput, maxJsonChars };
