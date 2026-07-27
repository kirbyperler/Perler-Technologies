(() => {
  const form = document.getElementById('admin-login-form');
  if (!form) return;

  const status = document.getElementById('form-status');
  const submitButton = form.querySelector('.submit-button');
  const buttonLabel = submitButton?.querySelector('.button-label');

  const setFieldError = (name, message = '') => {
    const field = form.elements[name];
    const error = form.querySelector(`[data-error-for="${name}"]`);
    const group = field?.closest('.field-group');

    if (error) error.textContent = message;
    group?.classList.toggle('has-error', Boolean(message));
    field?.setAttribute('aria-invalid', String(Boolean(message)));
  };

  const clearErrors = () => {
    ['email', 'password'].forEach(name => setFieldError(name));
    if (status) status.textContent = '';
  };

  const setLoading = loading => {
    if (!submitButton) return;
    submitButton.classList.toggle('is-loading', loading);
    submitButton.disabled = loading;
    if (buttonLabel) buttonLabel.textContent = loading ? 'Signing in' : 'Log in';
  };

  // If a valid session already exists, skip the login form entirely.
  fetch('/api/auth?action=session', { credentials: 'same-origin' })
    .then(response => { if (response.ok) window.location.href = '/admin'; })
    .catch(() => {});

  form.addEventListener('submit', async event => {
    event.preventDefault();
    clearErrors();

    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;

    if (!email) return setFieldError('email', 'Please enter your email.');
    if (!password) return setFieldError('password', 'Please enter your password.');

    setLoading(true);
    try {
      const response = await fetch('/api/auth?action=login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || 'Login failed. Please try again.');
      }

      window.location.href = '/admin';
    } catch (error) {
      if (status) status.textContent = error.message;
      setLoading(false);
    }
  });
})();
