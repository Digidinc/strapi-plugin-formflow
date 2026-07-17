# Telegram notifications

Telegram notifications are a **Pro** feature that sends a rich message after a final form submission. FormFlow uses a customer-owned bot and is outbound-only: it does not poll for updates, install or delete webhooks, receive commands, change bot/profile/chat settings, or administer destinations.

> **No bot backend, deployment, public URL, or webhook is required for notification-only setup.** You need only BotFather, a bot token, a destination, and the FormFlow test action.

## 1. Create and secure a bot

1. Open [@BotFather](https://t.me/BotFather), run `/newbot`, and follow the prompts. See Telegram's [bot introduction](https://core.telegram.org/bots#how-do-i-create-a-bot).
2. Copy the Bot API token once and treat it like a password. Anyone holding it controls the bot. Never put it in source control, browser code, screenshots, support tickets, logs, or a public API response.
3. Set a stable, base64-encoded 32-byte encryption key for stored credentials:

   ```sh
   export FORMFLOW_ENCRYPTION_KEY="$(openssl rand -base64 32)"
   ```

   Keep this key stable across restarts and replicas. Losing or changing it makes stored tokens unreadable.
4. Prefer an environment-backed token in production. Put the token in a server-only variable of your choice, for example `TELEGRAM_NOTIFICATIONS_TOKEN`, then select that **variable name** when creating the FormFlow connection. FormFlow stores the name, not the resolved value. Environment variable names must use uppercase letters, digits, and underscores and may not start with a digit.

If a token may have leaked, revoke/regenerate it in BotFather immediately, update the environment secret (or use **Replace token**), restart affected processes, and send a new test message. Rotation does not require editing every form because forms reference the connection's stable ID.

## 2. Prepare a destination

FormFlow accepts either a numeric chat ID (including negative group/channel IDs) or a public `@username`.

- **Private chat:** Telegram bots cannot start conversations. The recipient must open the bot and press **Start** or send it a message before the bot can notify that chat.
- **Group:** add the bot. Sending messages is the minimum permission needed; administrator access is unnecessary unless the group's policy requires it.
- **Channel:** add the bot as an administrator with permission to post messages. Do not grant edit, delete, invite, or user-management permissions unless another use of the bot requires them.
- **Public channel/group:** its public `@username` is the simplest destination.
- **Private destination:** use its numeric ID. IDs shown in forwarded-message tools or Bot API development output should be verified carefully; do not expose submission data while finding one. FormFlow intentionally does not consume updates to discover IDs.

## 3. Configure FormFlow

1. In **FormFlow Settings -> Telegram**, add a connection. Choose either an encrypted stored token or an environment variable name.
2. Confirm the bot identity returned by Telegram, then save. A Pro installation supports one active customer-owned connection.
3. Send the safe connection test. The test contains fixed sample text and no real submission values.
4. Open a form, choose **Notifications -> Telegram**, select the connection and destination, edit the focused rich template, send a test, enable it, and save the form.

Templates use FormFlow's structured editor, not raw HTML, Markdown, or Bot API JSON. Field variables use stable field IDs. A deleted field becomes a validation error rather than silently substituting another field.

## Privacy and delivery behavior

Every selected field value leaves your Strapi installation and is delivered to Telegram and destination members. Avoid passwords, payment details, access tokens, health data, private uploads, and other sensitive fields. Review membership, message retention, forwarding, and Telegram's privacy terms before enabling a template. FormFlow warns about password fields, but administrators remain responsible for data minimization.

Delivery is fire-and-forget after a final submission is persisted. It does not delay or change the public submission response. Draft saves and submission status changes do not notify. The first release makes **one attempt only**: no retry, queue, replay, or persisted delivery status. A timeout, network problem, Telegram `429`, or `5xx` is logged safely and is not retried. Telegram applies per-chat and broadcast limits; see the [Bot FAQ limits guidance](https://core.telegram.org/bots/faq#broadcasting-to-users). Design expected volume accordingly.

## Troubleshooting

- **Invalid credential / authentication:** rotate the token; check that the configured environment variable exists in the Strapi process (not only your shell), then restart.
- **Encryption-key error:** `FORMFLOW_ENCRYPTION_KEY` must decode to exactly 32 bytes. Do not rotate it independently of encrypted credentials.
- **Chat not found:** verify the numeric ID or public username. For private chat, the user must start the bot first.
- **Forbidden / insufficient permission:** re-add the bot or grant only the ability to send/post messages. Confirm it has not been blocked.
- **Rate limited:** wait for Telegram's indicated interval. FormFlow deliberately will not retry the failed notification.
- **Timeout/network/server error:** verify outbound HTTPS access to `api.telegram.org` and try the safe test later.
- **Invalid template / stale field:** remove unsupported content, fix the highlighted field reference, or shorten expanded values.
- **Test succeeds but submissions do not notify:** confirm the form is active, Telegram is enabled, the connection is active for the current license, and the event is a new final submission.
- **An interactive bot stopped receiving updates:** inspect webhook ownership. FormFlow never manages webhooks, but another backend or Telegram Serverless may replace the bot's single webhook.

Telegram references: [Bot API](https://core.telegram.org/bots/api), [Bot FAQ](https://core.telegram.org/bots/faq), and [Bot API changelog](https://core.telegram.org/bots/api-changelog).
