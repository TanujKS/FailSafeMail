/**
 * Fail-Safe Email Worker
 *
 * Forwards incoming emails to configured target addresses based on recipient
 * If delivery fails, saves email to R2 bucket and alerts Discord webhook
 */

import emailRouting from "../config/routes.json";

function log(env, ...args) {
	if (env.DEBUG) console.log(...args);
}

function logError(env, ...args) {
	if (env.DEBUG) console.error(...args);
}

export default {
	async email(message, env, _ctx) {
		try {
			log(env, `Processing email from ${message.from} to ${message.to}`);

			const recipient = message.to.toLowerCase();
			let targetEmail = emailRouting[recipient];

			if (!targetEmail) {
				const domain = recipient.split('@')[1];
				if (domain) {
					targetEmail = emailRouting[`@${domain}`];
					if (targetEmail) {
						log(env, `Found catch-all rule @${domain} -> ${targetEmail}`);
					}
				}
			} else {
				log(env, `Found exact match: ${recipient} -> ${targetEmail}`);
			}

			if (!targetEmail) {
				targetEmail = emailRouting['@default'];
				if (targetEmail) {
					log(env, `Using global default: @default -> ${targetEmail}`);
				}
			}

			if (!targetEmail) {
				logError(env, `No routing rule found for recipient: ${recipient}`);
				await sendDiscordAlert(
					message,
					env,
					new Error(`No routing rule found for recipient: ${recipient}`),
					null,
					null,
				);
				return;
			}

			try {
				await message.forward(targetEmail);
				log(
					env,
					`Email from ${message.from} to ${recipient} successfully forwarded to ${targetEmail}`,
				);
			} catch (error) {
				logError(
					env,
					`Failed to forward email from ${message.from} to ${recipient}:`,
					error,
				);

				let emailContent = null;
				try {
					const emailStream = await message.raw;
					emailContent = await new Response(emailStream).text();
				} catch (contentError) {
					logError(env, "Failed to extract email content:", contentError);
				}

				await saveEmailToR2(env, message, targetEmail, emailContent);
				await sendDiscordAlert(message, env, error, targetEmail, emailContent);
			}
		} catch (error) {
			await sendErrorToDiscord(env, error);
		}
	},

	async fetch(request, env, _ctx) {
		try {
			const url = new URL(request.url);

			if (url.pathname === "/test-error") {
				throw new Error("Test error: verifying Discord webhook");
			}

			return new Response("Fail-Safe Email Worker is running");
		} catch (error) {
			await sendErrorToDiscord(env, error);
			return new Response("Internal Server Error", { status: 500 });
		}
	},
};

/**
 * Save email to R2 bucket as backup
 */
async function saveEmailToR2(env, message, targetEmail, emailContent) {
	try {
		const timestamp = new Date().toISOString();
		const filename = `email-backup-${timestamp}-${message.from.replace(/[^a-zA-Z0-9]/g, "_")}.eml`;

		let emailBuffer;
		if (emailContent) {
			const encoder = new TextEncoder();
			emailBuffer = encoder.encode(emailContent).buffer;
		} else {
			const emailStream = await message.raw;
			emailBuffer = await new Response(emailStream).arrayBuffer();
		}

		await env.EMAIL_STORAGE.put(filename, emailBuffer, {
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

		log(env, `Email saved to R2: ${filename}`);
	} catch (error) {
		logError(env, "Failed to save email to R2:", error);
	}
}

/**
 * Send Discord alert for failed email delivery
 */
async function sendDiscordAlert(message, env, error, targetEmail, emailContent) {
	try {
		const webhookUrl = env.DISCORD_WEBHOOK_URL;

		if (!webhookUrl) {
			logError(env, "DISCORD_WEBHOOK_URL not configured");
			return;
		}

		let displayContent = "Unable to read email content";
		if (emailContent) {
			try {
				const bodyMatch = emailContent.match(/(?:\r?\n){2,}(.*)/s);
				if (bodyMatch) {
					displayContent = bodyMatch[1].trim();
					if (displayContent.length > 1000) {
						displayContent = displayContent.substring(0, 997) + "...";
					}
				} else {
					displayContent = emailContent.length > 1000
						? emailContent.substring(0, 997) + "..."
						: emailContent;
				}
			} catch (contentError) {
				logError(env, "Failed to process email content:", contentError);
				displayContent = "Error processing email content";
			}
		}

		const embed = {
			title: "🚨 Email Delivery Failed",
			description: `Failed to forward email from **${message.from}** to **${targetEmail || "unknown target"}**`,
			color: 0xff0000,
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
					name: "Email Content",
					value: `\`\`\`${displayContent}\`\`\``,
					inline: false,
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

		const response = await fetch(webhookUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ embeds: [embed] }),
		});

		if (!response.ok) {
			throw new Error(
				`Discord webhook failed: ${response.status} ${response.statusText}`,
			);
		}

		log(env, "Discord alert sent successfully");
	} catch (alertError) {
		logError(env, "Failed to send Discord alert:", alertError);
	}
}

/**
 * Send a simple error report to Discord for unexpected worker errors
 */
async function sendErrorToDiscord(env, error) {
	try {
		const webhookUrl = env.DISCORD_WEBHOOK_URL;
		if (!webhookUrl) return;

		const embed = {
			title: "⚠️ Unexpected Worker Error",
			color: 0xff6600,
			fields: [
				{
					name: "Error",
					value: `\`\`\`${error.message}\`\`\``,
					inline: false,
				},
				{
					name: "Stack Trace",
					value: `\`\`\`${(error.stack || "No stack trace").substring(0, 1000)}\`\`\``,
					inline: false,
				},
				{
					name: "Timestamp",
					value: new Date().toISOString(),
					inline: true,
				},
			],
			timestamp: new Date().toISOString(),
		};

		await fetch(webhookUrl, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ embeds: [embed] }),
		});
	} catch (_) {
		// Last resort — nothing more we can do
	}
}
