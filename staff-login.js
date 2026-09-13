const form = document.getElementById('staff-login-form');
const username = document.getElementById('staff-username');
const password = document.getElementById('staff-password');
const toggle = document.getElementById('toggle-staff-password');
const submit = document.getElementById('staff-login-submit');
const errorMessage = document.getElementById('staff-login-error');
const requestedNext = new URLSearchParams(window.location.search).get('next') || '/register';

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
    const response = await fetch('/api/orders/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: username.value.trim(),
        password: password.value,
        next: requestedNext,
      }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Sign-in was unsuccessful. Please try again.');
    window.location.replace(data.next || '/register');
  } catch (error) {
    password.select();
    showError(error.message || 'Sign-in was unsuccessful. Please try again.');
  } finally {
    submit.disabled = false;
    submit.querySelector('span').textContent = 'Sign in securely';
  }
});

username.focus();
