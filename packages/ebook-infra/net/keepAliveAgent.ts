import { Agent } from 'node:https';

/**
 * Shared outbound HTTPS agent for every third-party API client on the worker
 * (googleapis, OpenAI/Whisper, Anthropic/Claude).
 *
 * `keepAlive: false` — on a long-lived worker the default pooled keep-alive
 * sockets get silently closed by the remote (or a hop in Railway's egress);
 * Node then reuses the dead socket and the response body read fails mid-stream
 * with "Invalid response body ... : Premature close". The error reproduces on
 * every retry because they all grab the same poisoned connection. Opening a
 * fresh socket per request removes that failure mode entirely.
 *
 * `family: 4` — force IPv4. Broken IPv6 egress is a common secondary cause of
 * the same symptom; pairs with NODE_OPTIONS=--dns-result-order=ipv4first.
 */
export const keepAliveAgent = new Agent({ keepAlive: false, family: 4 });
