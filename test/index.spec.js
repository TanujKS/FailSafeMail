import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src';

// Mock fetch for Discord webhook testing
global.fetch = vi.fn();

describe('Fail-Safe Email Worker', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('HTTP endpoint', () => {
		it('responds with worker status (unit style)', async () => {
			const request = new Request('http://example.com');
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);
			expect(await response.text()).toMatchInlineSnapshot(`"Fail-Safe Email Worker is running"`);
		});

		it('responds with worker status (integration style)', async () => {
			const response = await SELF.fetch('http://example.com');
			expect(await response.text()).toMatchInlineSnapshot(`"Fail-Safe Email Worker is running"`);
		});
	});

	describe('Email handling', () => {
		it('should forward email successfully', async () => {
			const mockMessage = {
				from: 'test@example.com',
				to: 'worker@example.com',
				headers: new Headers({ 'subject': 'Test Email' }),
				forward: vi.fn().mockResolvedValue(undefined),
				raw: Promise.resolve(new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('Raw email content'));
						controller.close();
					}
				}))
			};

			const mockEnv = {
				EMAIL_STORAGE: { put: vi.fn() }
			};

			const ctx = createExecutionContext();
			await worker.email(mockMessage, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			expect(mockMessage.forward).toHaveBeenCalledWith('tanujsiripurapu@gmail.com');
		});

		it('should save to R2 and send Discord alert on forward failure', async () => {
			const mockError = new Error('Forward failed');
			const mockMessage = {
				from: 'test@example.com',
				to: 'worker@example.com',
				headers: new Headers({ 'subject': 'Test Email' }),
				forward: vi.fn().mockRejectedValue(mockError),
				raw: Promise.resolve(new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('Raw email content'));
						controller.close();
					}
				}))
			};

			// Mock R2 bucket
			const mockR2Bucket = {
				put: vi.fn().mockResolvedValue(undefined)
			};

			// Mock Discord webhook
			global.fetch.mockResolvedValue({
				ok: true,
				status: 200
			});

			const mockEnv = {
				EMAIL_STORAGE: mockR2Bucket,
				DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/test'
			};

			const ctx = createExecutionContext();
			await worker.email(mockMessage, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			// Verify forward was attempted
			expect(mockMessage.forward).toHaveBeenCalledWith('tanujsiripurapu@gmail.com');

			// Verify R2 save was attempted
			expect(mockR2Bucket.put).toHaveBeenCalled();
			const r2Call = mockR2Bucket.put.mock.calls[0];
			expect(r2Call[0]).toMatch(/email-backup-.*-test_example_com\.eml/);
			expect(r2Call[1]).toBeInstanceOf(ArrayBuffer);
			expect(r2Call[2].httpMetadata.contentType).toBe('message/rfc822');

			// Verify Discord webhook was called
			expect(global.fetch).toHaveBeenCalledWith(
				'https://discord.com/api/webhooks/test',
				expect.objectContaining({
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: expect.stringContaining('Email Delivery Failed')
				})
			);
		});

		it('should handle missing Discord webhook URL gracefully', async () => {
			const mockError = new Error('Forward failed');
			const mockMessage = {
				from: 'test@example.com',
				to: 'worker@example.com',
				headers: new Headers({ 'subject': 'Test Email' }),
				forward: vi.fn().mockRejectedValue(mockError),
				raw: Promise.resolve(new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode('Raw email content'));
						controller.close();
					}
				}))
			};

			const mockR2Bucket = {
				put: vi.fn().mockResolvedValue(undefined)
			};

			const mockEnv = {
				EMAIL_STORAGE: mockR2Bucket,
				DISCORD_WEBHOOK_URL: undefined
			};

			const ctx = createExecutionContext();
			await worker.email(mockMessage, mockEnv, ctx);
			await waitOnExecutionContext(ctx);

			// Should still save to R2
			expect(mockR2Bucket.put).toHaveBeenCalled();
			
			// Should not call Discord webhook
			expect(global.fetch).not.toHaveBeenCalled();
		});
	});
});
