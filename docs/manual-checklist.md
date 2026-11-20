# Lead Desk Manual Verification Checklist

> **Prerequisite:** Run against a single real session using the operator's own second phone number as the only recipient. Do not test against live customer numbers.

---

### Verification Items

1. **Pairing & Sender Acquisition**
   - Click "Pair New Device" on the `/connection` dashboard screen to generate an 8-character Crockford code.
   - Enter the code in the extension popup on Chrome/Brave.
   - Status screen displays the device with green `sender` badge. Heartbeat age stays under 15 seconds.

2. **Single Tab Sender Election**
   - Open a second WhatsApp Web tab in the same browser.
   - The popup on the first tab stays `sender`. The second tab remains `standby` and does not claim or send.
   - Close the first tab. Within 15 seconds, the second tab is elected `sender`.

3. **Multi-Browser Failover and Grace Recovery**
   - Pair a second browser profile (e.g. Brave while Chrome is running).
   - The second browser stays `standby` and does not take the lease while the first browser's tab is active.
   - Close all WhatsApp Web tabs on the first browser.
   - The second browser must remain in `standby` for 30 seconds (`grace_until`), then acquire the lease and become `sender` because its ready tab reports `senderTab: true`.
   - In Dashboard `/connection`, clicking **Make Sender** moves the lease immediately without waiting for grace.
   - Reload the holder's tab during grace and verify that browser recovers `sender` before the 30-second window expires.

4. **Network Drop After Bubble Appears (No Second Bubble)**
   - Create a lead with the second phone number.
   - Click **Send Now**. One bubble appears in WhatsApp.
   - Sever network connectivity immediately after the bubble is sent in WhatsApp Web but before the server `ack` completes.
   - Restore network connectivity.
   - Verify that the local outbox mirror replays the `ack` with the same `wa_message_id`, the queue row marks `sent`, and **no duplicate bubble** is sent.

5. **Server Kill / Uncertain Resolution**
   - If bridge resolve cannot reach the server, verify the extension writes `phase: "uncertain"` and posts `uncertain` when reconnected.
   - Row transitions to `needs_review` with `attempt_count` preserved.
   - Wait 2 minutes: verify no second bubble sends automatically.
   - In Dashboard Queue, click **Retry**: both token hashes clear and status moves to `queued`. Confirm the old claim token cannot ack the new attempt.

6. **Scheduled Messages**
   - Schedule a message 2 minutes out.
   - Verify row remains `queued` until due, claims outside quiet hours, and sends exactly once.

7. **Sequences and Step Materialization**
   - Create a sequence with 2 steps (step 0 delay: 0s, step 1 delay: 120s).
   - Enroll the test lead. Step 0 is materialized immediately. Step 1 does **not** exist in `outbound_queue` until step 0 acks.
   - Cancel the enrollment between steps: verify step 1 is never created or sent.

8. **Inbound Capture with Global Mode Off**
   - Send an inbound text from the second phone.
   - Verify it appears in `/log` and lead timeline with `ai_state = "skipped"` and `ai_reason = "global_off"`. No reply is sent.
   - Reply directly from the operator's phone inside WhatsApp: verify an outbound row is logged with `fromMe = 1` and `ai_state = null`, with no model call.

9. **AI Approve Mode**
   - Set global AI mode to `approve` in `/ai`.
   - Enable AI on the test lead only (`ai_enabled = 1`).
   - Send an inbound text from the second phone.
   - A draft reply appears in Queue -> **Needs Approval**. Nothing sends to WhatsApp until approved.
   - Discarding the draft marks it `cancelled` and sends nothing.

10. **Draft Approval & Exact Text Match**
    - Click **Approve** on a drafted reply.
    - Confirm the message sends to the phone and matches the draft text exactly.

11. **Quiet Hours Guardrails**
    - Set quiet hours to cover current local time in `/settings`.
    - An inbound text from the test phone is logged as `ai_reason = "quiet_hours"` and **never deferred to morning**.
    - Attempting to approve an existing draft during quiet hours returns HTTP 409 `quiet_hours` and leaves it `needs_approval`.
    - A scheduled message due inside quiet hours rolls `due_at` to the opening minute.

12. **Automated Send Cap**
    - Set daily automated send cap to 1.
    - Trigger two automated replies: verify the second is blocked by cap guard.

13. **Non-Direct Chat Filter**
    - A group message (`@g.us`) or WhatsApp Status post (`status@broadcast`) is ignored and does not generate outbound rows or replies.

14. **Device Revocation**
    - In Dashboard `/connection`, revoke the paired device.
    - Extension badge turns grey, stops claiming from the queue, and does not retry with the revoked token.

15. **Operator Setup Security**
    - Attempting setup with an invalid bootstrap secret returns HTTP 401.
    - Once setup is completed, subsequent setup attempts return HTTP 409 `already_setup`.

16. **Probe Connection Safety**
    - In `/ai`, click **Test Connection (Probe)** with an invalid key: displays 502 error and never sends an outbound message.

17. **Extension Dist Secret Grep**
    - Run secret check: verify `apps/extension/dist` contains zero instances of `XAI_API_KEY`, `.env`, or tokens.

18. **WhatsApp UI Ready Gate & Stream Mode**
    - Reload WhatsApp Web from both authenticated state and fresh QR login.
    - Verify extension waits until chat list `#pane-side` is visible before injecting bridge scripts, and waits until stream mode is `MAIN` (not `SYNCING`).

19. **LID Address Resolution**
    - An inbound message from a LID chat (`...@lid`) resolves to the existing lead rather than creating a duplicate lead with a synthesized phone number.

20. **Foreign WPP Collision Probe**
    - If another extension or script defines `window.WPP` before Lead Desk injects, `probe-wpp.js` flags `window.__LEAD_DESK_FOREIGN_WPP__ = true` and `page-bridge.js` aborts safely without crashing the tab or overriding `WPP`.
