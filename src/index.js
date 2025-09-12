/**
 * Fail-Safe Email Worker
 * 
 * Forwards all incoming emails to tanujsiripurapu@gmail.com
 * If delivery fails, saves email to R2 bucket and alerts Discord webhook
 */

export default {
	async email(message, env, ctx) {
		const targetEmail = "tanujsiripurapu@gmail.com";
		
		try {
			// Forward the email to the target address
			await message.forward(targetEmail);
			console.log(`Email from ${message.from} successfully forwarded to ${targetEmail}`);
		} catch (error) {
			console.error(`Failed to forward email from ${message.from}:`, error);
			
			// Save email to R2 bucket as backup
			await saveEmailToR2(message, env);
			
			// Send Discord alert
			await sendDiscordAlert(message, env, error);
		}
	},

	async fetch(request, env, ctx) {
		return new Response('Fail-Safe Email Worker is running');
	},
};

/**
 * Save email to R2 bucket as backup
 */
async function saveEmailToR2(message, env) {
	try {
		const timestamp = new Date().toISOString();
		const filename = `email-backup-${timestamp}-${message.from.replace(/[^a-zA-Z0-9]/g, '_')}.eml`;
		
		// Get email content as ArrayBuffer
		const emailStream = await message.raw;
		const emailContent = await new Response(emailStream).arrayBuffer();
		
		// Save to R2
		await env.EMAIL_STORAGE.put(filename, emailContent, {
			httpMetadata: {
				contentType: 'message/rfc822'
			},
			customMetadata: {
				from: message.from,
				to: message.to,
				subject: message.headers.get('subject') || 'No Subject',
				timestamp: timestamp,
				originalRecipient: message.to
			}
		});
		
		console.log(`Email saved to R2: ${filename}`);
	} catch (error) {
		console.error('Failed to save email to R2:', error);
	}
}

/**
 * Send Discord alert for failed email delivery
 */
async function sendDiscordAlert(message, env, error) {
	try {
		const webhookUrl = env.DISCORD_WEBHOOK_URL;
		
		if (!webhookUrl) {
			console.error('DISCORD_WEBHOOK_URL not configured');
			return;
		}
		
		const embed = {
			title: "🚨 Email Delivery Failed",
			description: `Failed to forward email from **${message.from}** to **tanujsiripurapu@gmail.com**`,
			color: 0xff0000, // Red color
			fields: [
				{
					name: "From",
					value: message.from,
					inline: true
				},
				{
					name: "To",
					value: message.to,
					inline: true
				},
				{
					name: "Subject",
					value: message.headers.get('subject') || 'No Subject',
					inline: true
				},
				{
					name: "Error",
					value: `\`\`\`${error.message}\`\`\``,
					inline: false
				},
				{
					name: "Timestamp",
					value: new Date().toISOString(),
					inline: true
				},
				{
					name: "Status",
					value: "✅ Email saved to R2 backup",
					inline: true
				}
			],
			timestamp: new Date().toISOString()
		};
		
		const payload = {
			embeds: [embed]
		};
		
		const response = await fetch(webhookUrl, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
			},
			body: JSON.stringify(payload)
		});
		
		if (!response.ok) {
			throw new Error(`Discord webhook failed: ${response.status} ${response.statusText}`);
		}
		
		console.log('Discord alert sent successfully');
	} catch (error) {
		console.error('Failed to send Discord alert:', error);
	}
}
