/**
 * Fail-Safe Email Worker
 *
 * Forwards incoming emails to configured target addresses based on recipient
 * If delivery fails, saves email to R2 bucket and alerts Discord webhook
 */

export default {
	async email(message, env, ctx) {
		// Get email routing configuration (now a proper object)
		const emailRouting = env.EMAIL_ROUTING || {};
		console.log(`Processing email from ${message.from} to ${message.to}`);

		// Extract the recipient email from the 'to' field
		const recipient = message.to;
		let targetEmail = emailRouting[recipient];

		// If no exact match, try catch-all routing (@domain.com)
		if (!targetEmail) {
			const domain = recipient.split('@')[1];
			if (domain) {
				targetEmail = emailRouting[`@${domain}`];
				if (targetEmail) {
					console.log(`Found catch-all rule @${domain} -> ${targetEmail}`);
				}
			}
		} else {
			console.log(`Found exact match: ${recipient} -> ${targetEmail}`);
		}

		// If still no match, try global default (@default)
		if (!targetEmail) {
			targetEmail = emailRouting['@default'];
			if (targetEmail) {
				console.log(`Using global default: @default -> ${targetEmail}`);
			}
		}

		// Check if we have a routing rule for this recipient
		if (!targetEmail) {
			console.error(`No routing rule found for recipient: ${recipient}`);
			await sendDiscordAlert(
				message,
				env,
				new Error(`No routing rule found for recipient: ${recipient}`),
				null,
			);
			return;
		}

		try {
			// Forward the email to the target address
			await message.forward(targetEmail);
			console.log(
				`Email from ${message.from} to ${recipient} successfully forwarded to ${targetEmail}`,
			);
		} catch (error) {
			console.error(
				`Failed to forward email from ${message.from} to ${recipient}:`,
				error,
			);

			// Save email to R2 bucket as backup
			await saveEmailToR2(message, env, targetEmail);

			// Send Discord alert
			await sendDiscordAlert(message, env, error, targetEmail);
		}
	},

	async fetch(request, env, ctx) {
		return new Response("Fail-Safe Email Worker is running");
	},
};

/**
 * Save email to R2 bucket as backup
 */
async function saveEmailToR2(message, env, targetEmail) {
	try {
		const timestamp = new Date().toISOString();
		const filename = `email-backup-${timestamp}-${message.from.replace(/[^a-zA-Z0-9]/g, "_")}.eml`;

		// Get email content as ArrayBuffer
		const emailStream = await message.raw;
		const emailContent = await new Response(emailStream).arrayBuffer();

		// Save to R2
		await env.EMAIL_STORAGE.put(filename, emailContent, {
			httpMetadata: {
				contentType: "message/rfc822",
			},
			customMetadata: {
				from: message.from,
				to: message.to,
				subject: message.headers.get("subject") || "No Subject",
				timestamp: timestamp,
				originalRecipient: message.to,
				targetEmail: targetEmail || "unknown",
			},
		});

		console.log(`Email saved to R2: ${filename}`);
	} catch (error) {
		console.error("Failed to save email to R2:", error);
	}
}

/**
 * Send Discord alert for failed email delivery
 */
async function sendDiscordAlert(message, env, error, targetEmail) {
	try {
		const webhookUrl = env.DISCORD_WEBHOOK_URL;

		if (!webhookUrl) {
			console.error("DISCORD_WEBHOOK_URL not configured");
			return;
		}

		const embed = {
			title: "🚨 Email Delivery Failed",
			description: `Failed to forward email from **${message.from}** to **${targetEmail || "unknown target"}**`,
			color: 0xff0000, // Red color
			fields: [
				{
					name: "From",
					value: message.from,
					inline: true,
				},
				{
					name: "Original Recipient",
					value: message.to,
					inline: true,
				},
				{
					name: "Target Email",
					value: targetEmail || "No routing rule found",
					inline: true,
				},
				{
					name: "Subject",
					value: message.headers.get("subject") || "No Subject",
					inline: true,
				},
				{
					name: "Error",
					value: `\`\`\`${error.message}\`\`\``,
					inline: false,
				},
				{
					name: "Timestamp",
					value: new Date().toISOString(),
					inline: true,
				},
				{
					name: "Status",
					value: targetEmail
						? "✅ Email saved to R2 backup"
						: "❌ No routing rule found",
					inline: true,
				},
			],
			timestamp: new Date().toISOString(),
		};

		const payload = {
			embeds: [embed],
		};

		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify(payload),
		});

		if (!response.ok) {
			throw new Error(
				`Discord webhook failed: ${response.status} ${response.statusText}`,
			);
		}

		console.log("Discord alert sent successfully");
	} catch (error) {
		console.error("Failed to send Discord alert:", error);
	}
}
