import { expect, test } from '@playwright/test';

for (const mobile of [false, true]) test.describe(mobile ? 'touch chat modal gating' : 'desktop chat modal gating', () => {
  test.use(mobile ? { isMobile: true, hasTouch: true, viewport: { width: 844, height: 390 } } : {});

  test('a closed settings dialog permits real chat; an open dialog blocks it; closing restores chat', async ({ page }) => {
    await page.goto('/?nodraw&steady');
    await page.fill('#name', mobile ? '触屏聊天验收' : '键盘聊天验收');
    await page.locator('#create').click();
    await page.locator('#start').click();
    await page.waitForFunction(() => {
      const g = window.__escape.game();
      return !!g?.presentationReady && !g.intro.active && g.input.enabled && window.__escape.net.connected;
    });
    await page.evaluate(() => window.__escape.debug('safe', 600));
    const dialog = page.locator('#game-settings'), field = page.locator('#chat-input');
    const openChat = async () => {
      if (mobile) await page.locator('#touch-chat').tap();
      else {
        await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
        await page.keyboard.press('Enter');
      }
    };

    await expect(dialog).toBeHidden();
    await expect(dialog).not.toHaveAttribute('open');
    await openChat();
    await expect(field).toBeVisible();
    await field.fill('设置未打开时可以聊天');
    await page.locator('#chat-send').click();
    await expect(page.locator('#chat-log')).toContainText('设置未打开时可以聊天');
    await expect(field).toBeHidden();

    await page.locator('#settings-open').click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('open', '');
    await dialog.focus();
    await page.keyboard.press('Enter');
    await expect(field).toBeHidden();
    expect(await page.evaluate(() => window.__escape.game()!.input.enabled)).toBe(false);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await openChat();
    await expect(field).toBeVisible();
    await field.fill('关闭设置后恢复聊天');
    await page.locator('#chat-send').click();
    await expect(page.locator('#chat-log')).toContainText('关闭设置后恢复聊天');
    await expect(field).toBeHidden();
    expect(await page.evaluate(() => window.__escape.game()!.input.enabled)).toBe(true);
  });
});
