# Fail-Safe Email Worker

A Cloudflare Email Worker that forwards all incoming emails to with automatic failover to R2 storage and Discord webhook alerts.

## Features

- ✅ Forwards all emails to a specified address (no allowlist required)
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

### 3. Set Discord Webhook Secret

Set the Discord webhook URL as a secret (recommended for security):

```bash
wrangler secret put DISCORD_WEBHOOK_URL
```

When prompted, enter your Discord webhook URL:
```
https://discord.com/api/webhooks/YOUR_WEBHOOK_ID/YOUR_WEBHOOK_TOKEN
```

### 4. Deploy the Worker

```bash
npm run deploy
```

### 5. Configure Email Routing

1. Go to Cloudflare Dashboard → Email Routing
2. Add your domain
3. Configure the worker to handle incoming emails
4. Set up email forwarding rules

## How It Works

1. **Email Reception**: All incoming emails are received by the worker
2. **Forwarding**: Emails are forwarded to `tanujsiripurapu@gmail.com`
3. **Error Handling**: If forwarding fails:
   - Email is saved to R2 bucket with metadata
   - Discord alert is sent with error details
   - Error is logged for debugging

## R2 Storage Format

Failed emails are stored in R2 with:
- **Filename**: `email-backup-{timestamp}-{sanitized_from}.eml`
- **Content-Type**: `message/rfc822`
- **Metadata**: from, to, subject, timestamp, originalRecipient

## Discord Alert Format

Discord alerts include:
- 🚨 Alert title and description
- Email details (from, to, subject)
- Error message
- Timestamp
- Backup confirmation

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
  "http://127.0.0.1:8787/cdn-cgi/handler/email?from=tsiripurapu@ucsb.edu&to=tanujsiripurapu@gmail.com" `
  -H "Content-Type: message/rfc822" `
  --data-binary "@sample.eml"
```

#### Using curl (Unix/Linux/macOS):

```bash
curl -v -X POST \
  "http://127.0.0.1:8787/cdn-cgi/handler/email?from=tsiripurapu@ucsb.edu&to=tanujsiripurapu@gmail.com" \
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

### Target Email
To change the target email address, update the `targetEmail` variable in `src/index.js`:

```javascript
const targetEmail = "your-email@example.com";
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
