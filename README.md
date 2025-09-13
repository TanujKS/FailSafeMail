# Fail-Safe Email Worker

A Cloudflare Email Worker that forwards incoming emails to multiple target addresses based on recipient with automatic failover to R2 storage and Discord webhook alerts.

## Features

- ✅ Routes emails to different addresses based on recipient (configurable via environment variables)
- ✅ Automatic backup to R2 bucket when delivery fails
- ✅ Discord webhook alerts for failed deliveries
- ✅ Comprehensive error handling and logging
- ✅ Full test coverage

## Setup

### 1. Prerequisites

- Cloudflare account with Workers and R2 enabled
- Discord webhook URL (optional but recommended)
- Wrangler CLI installed

### 2. Create R2 Bucket

Create the R2 bucket for email storage:

```bash
wrangler r2 bucket create fail-safe-mail-storage
```

### 3. Configure Email Routing

Update the email routing configuration in `wrangler.jsonc`:

```json
"vars": {
  "EMAIL_ROUTING": {
    "user1@yourdomain.com": "user1@personal.com",
    "user2@yourdomain.com": "user2@personal.com",
    "@yourdomain.com": "catchall@personal.com",
    "@default": "fallback@personal.com"
  }
}
```

You can add as many routing rules as needed. The format supports:
- **Exact matches**: `"recipient@domain.com": "target@domain.com"`
- **Catch-all routing**: `"@domain.com": "target@domain.com"` (for any email at that domain)
- **Global default**: `"@default": "target@domain.com"` (for any email that doesn't match other rules)

Example with multiple domains:
```json
"EMAIL_ROUTING": {
  "admin@company.com": "admin@personal.com",
  "support@company.com": "support@personal.com", 
  "@company.com": "catchall@personal.com",
  "@anotherdomain.com": "another@personal.com",
  "@default": "fallback@personal.com"
}
```

### 4. Set Discord Webhook Secret

Set the Discord webhook URL as a secret (recommended for security):

```bash
wrangler secret put DISCORD_WEBHOOK_URL
```

When prompted, enter your Discord webhook URL:

```
https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

### 5. Deploy the Worker

```bash
npm run deploy
```

### 6. Configure Email Routing

1. Go to Cloudflare Dashboard → Email Routing
2. Add your domain
3. Configure the worker to handle incoming emails
4. Set up email forwarding rules

## How It Works

1. **Email Reception**: All incoming emails are received by the worker
2. **Routing**: The worker checks the recipient email against the `EMAIL_ROUTING` configuration:
   - First tries exact match (e.g., `support@yourdomain.com`)
   - If no exact match, tries catch-all pattern (e.g., `@yourdomain.com`)
   - If still no match, uses global default (`@default`)
3. **Forwarding**: Emails are forwarded to the appropriate target address based on the routing rules
4. **Error Handling**: If forwarding fails or no routing rule exists:
   - Email is saved to R2 bucket with metadata
   - Discord alert is sent with error details
   - Error is logged for debugging

## R2 Storage Format

Failed emails are stored in R2 with:

- **Filename**: `email-backup-{timestamp}-{sanitized_from}.eml`
- **Content-Type**: `message/rfc822`
- **Metadata**: from, to, subject, timestamp, originalRecipient, targetEmail

## Discord Alert Format

Discord alerts include:

- 🚨 Alert title and description
- Email details (from, original recipient, target email, subject)
- Error message
- Timestamp
- Backup confirmation or routing error status

## Testing

Run the test suite:

```bash
npm test
```

Tests cover:

- Successful email forwarding
- R2 backup on failure
- Discord alerting
- Error handling scenarios

## Development

Start local development:

```bash
npm run dev
```

### Testing with Sample Email

You can test the email worker locally using the provided `sample.eml` file. The worker will be available at `http://127.0.0.1:8787`.

#### Using curl (Windows PowerShell):

```powershell
curl.exe -v -X POST `
  "http://127.0.0.1:8787/cdn-cgi/handler/email?from=sender@example.com&to=user1@personal.com" `
  -H "Content-Type: message/rfc822" `
  --data-binary "@sample.eml"
```

#### Using curl (Unix/Linux/macOS):

```bash
curl -v -X POST \
  "http://127.0.0.1:8787/cdn-cgi/handler/email?from=sender@example.com&to=user1@personal.com" \
  -H "Content-Type: message/rfc822" \
  --data-binary "@sample.eml"
```

This will:

1. Send the sample email to your local worker
2. Attempt to forward it
3. If forwarding fails (which it will in local dev), save it to R2 and send a Discord alert
4. Show detailed logs in your terminal

**Note**: In local development, email forwarding will fail since you're not connected to a real SMTP server, but this allows you to test the R2 backup and Discord alerting functionality.

## Configuration

### Email Routing

To configure email routing, update the `EMAIL_ROUTING` environment variable in `wrangler.jsonc`:

```json
"vars": {
  "EMAIL_ROUTING": {
    "recipient@domain.com": "target@domain.com",
    "@domain.com": "catchall@domain.com",
    "@default": "fallback@domain.com"
  }
}
```

You can add multiple routing rules with exact matches, catch-all patterns, and global default:

```json
"vars": {
  "EMAIL_ROUTING": {
    "user1@yourdomain.com": "user1@personal.com",
    "user2@yourdomain.com": "user2@personal.com",
    "@yourdomain.com": "catchall@personal.com",
    "@default": "fallback@personal.com"
  }
}
```

### R2 Bucket Name

Update the bucket name in `wrangler.jsonc`:

```json
"r2_buckets": [
  {
    "binding": "EMAIL_STORAGE",
    "bucket_name": "your-bucket-name"
  }
]
```

## Monitoring

- Check Cloudflare Workers logs for email processing status
- Monitor R2 bucket for failed email backups
- Discord alerts provide real-time failure notifications

## Troubleshooting

### Common Issues

1. **Emails not being forwarded**
   - Check email routing configuration
   - Verify worker is deployed and active
   - Check worker logs for errors

2. **R2 backup not working**
   - Verify R2 bucket exists and is accessible
   - Check bucket permissions
   - Review worker logs for R2 errors

3. **Discord alerts not sending**
   - Verify webhook URL is correct
   - Check Discord webhook permissions
   - Review worker logs for fetch errors

### Debug Mode

Enable detailed logging by checking the Cloudflare Workers dashboard logs or using:

```bash
wrangler tail
```
