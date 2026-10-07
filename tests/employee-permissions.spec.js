const { test, expect } = require('@playwright/test');

async function openEditor(page) {
  await page.goto('/staff-login.html');
  await page.setContent('<section id="tab-captain-app"><div id="captain-admin-list"></div></section>');
  await page.addScriptTag({ url: '/staff-domain.js' });
  await page.addScriptTag({ url: '/employee-admin.js' });
  await page.evaluate(() => {
    document.getElementById('captain-admin-list').innerHTML = window.renderEmployeeCards([{id:'cap', name:'Captain', role:'captain', areas:['AC'], tableScope:'own'}], ['AC','BAR']);
  });
  await page.getByRole('tab', { name: 'Permissions' }).click();
}

test('permission tabs support keyboard navigation and discount controls follow the grant', async ({ page }) => {
  await openEditor(page);
  await expect(page.locator('[data-employee-discount-value]')).toBeDisabled();
  await page.locator('[value="applyDiscounts"]').check();
  await expect(page.locator('[data-employee-discount-value]')).toBeEnabled();
  await page.locator('[data-employee-discount-type]').selectOption('percent');
  await page.locator('[data-employee-discount-value]').fill('101');
  expect(await page.locator('[data-employee-discount-value]').evaluate(input => input.checkValidity())).toBe(false);
  await page.getByRole('tab', { name: 'Permissions' }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('tab', { name: 'Basic details' })).toBeFocused();
  await expect(page.getByRole('tab', { name: 'Basic details' })).toHaveAttribute('aria-selected','true');
});

test('assigned-area scope requires an area and the editor fits a phone', async ({ page }) => {
  await page.setViewportSize({ width:390, height:844 });
  await openEditor(page);
  await page.locator('[data-captain-scope]').selectOption('assigned_areas');
  await page.locator('[data-captain-area][value="AC"]').uncheck();
  expect(await page.locator('[data-captain-scope]').evaluate(input => input.checkValidity())).toBe(false);
  await page.locator('[data-captain-area][value="BAR"]').check();
  expect(await page.locator('[data-captain-scope]').evaluate(input => input.checkValidity())).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('permission help works on hover, keyboard and tap without changing grants', async ({ page }) => {
  await openEditor(page);
  const grant = page.locator('[data-captain-permission][value="specialDiscounts"]');
  const row = grant.locator('..').locator('..');
  await row.hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip).toContainText('does not bypass the limit');
  await expect(grant).not.toBeChecked();
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  await grant.focus();
  await expect(tooltip).toBeVisible();
  await page.setViewportSize({ width:390, height:844 });
  const help = row.getByRole('button');
  await help.click();
  await expect(help).toHaveAttribute('aria-expanded', 'true');
  await expect(tooltip).toBeVisible();
  await expect(grant).not.toBeChecked();
  const bounds = await tooltip.boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await help.click();
  await expect(tooltip).toBeHidden();
  expect(await page.locator('.employee-permission-option').evaluateAll(rows => rows.every(row => row.dataset.permissionHelp && row.querySelector('input').getAttribute('aria-describedby')))).toBe(true);
});
