const form = document.getElementById('staff-login-form');
const username = document.getElementById('staff-username');
const password = document.getElementById('staff-password');
const toggle = document.getElementById('toggle-staff-password');
const submit = document.getElementById('staff-login-submit');
const errorMessage = document.getElementById('staff-login-error');
const stayLoggedIn = document.getElementById('staff-stay-logged-in');
const params = new URLSearchParams(window.location.search);
const scope = params.get('scope') === 'admin' ? 'admin' : 'orders';
const authConfig =
  scope === 'admin'
    ? {
        endpoint: '/api/admin/session',
        next: '/admin',
        kicker: 'Administrator access',
        intro: 'Sign in to manage restaurant settings, staff, menus and operations.',
        title: 'Admin Sign In · Red Lantern',
        brandTitle: 'Control every service from one secure place.',
        brandCopy: 'Access restaurant settings, staff controls, menu management and operational reports.',
        usernamePlaceholder: 'Enter administrator username',
      }
    : {
        endpoint: '/api/orders/session',
        next: '/register',
        kicker: 'Staff access',
        intro: 'Sign in to open Orders, Register and Kitchen displays.',
        title: 'Staff Sign In · Red Lantern',
        brandTitle: 'Service starts with a secure sign-in.',
        brandCopy: 'Access Orders, Register and Kitchen displays from one protected staff workspace.',
        usernamePlaceholder: 'Enter staff username',
      };
const requestedNext = params.get('next') || authConfig.next;

document.title = authConfig.title;
document.getElementById('staff-login-kicker').textContent = authConfig.kicker;
document.getElementById('staff-login-intro').textContent = authConfig.intro;
document.getElementById('staff-login-brand-title').textContent = authConfig.brandTitle;
document.getElementById('staff-login-brand-copy').textContent = authConfig.brandCopy;
username.placeholder = authConfig.usernamePlaceholder;

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.hidden = !message;
}

toggle.addEventListener('click', () => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  toggle.textContent = show ? 'Hide' : 'Show';
  toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  password.focus();
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError('');
  if (!username.value.trim() || !password.value) {
    showError('Enter both the staff username and password.');
    (!username.value.trim() ? username : password).focus();
    return;
  }

  submit.disabled = true;
  submit.querySelector('span').textContent = 'Signing in…';
  try {
    const response = await fetch(authConfig.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username.value.trim(),
        password: password.value,
        next: requestedNext,
        remember: stayLoggedIn.checked,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Sign-in was unsuccessful. Please try again.');
    window.location.replace(data.next || authConfig.next);
  } catch (error) {
    password.select();
    showError(error.message || 'Sign-in was unsuccessful. Please try again.');
  } finally {
    submit.disabled = false;
    submit.querySelector('span').textContent = 'Sign in securely';
  }
});

username.focus();
