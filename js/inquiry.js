(() => {
  const form = document.getElementById('inquiry-form');
  if (!form) return;

  const status = document.getElementById('form-status');
  const successPanel = document.getElementById('success-panel');
  const details = document.getElementById('project-details');
  const detailsCount = document.getElementById('details-count');
  const submitButton = form.querySelector('.submit-button');
  const buttonLabel = submitButton?.querySelector('.button-label');

  const requiredMessages = {
    name: 'Please enter your name.',
    email: 'Please enter a valid email address.',
    phone: 'Please enter your phone number.',
    projectType: 'Please select a project type.',
    projectDetails: 'Please tell us about your project.'
  };

  const setFieldError = (name, message = '') => {
    const field = form.elements[name];
    const error = form.querySelector(`[data-error-for="${name}"]`);
    const group = field?.closest('.field-group');

    if (error) error.textContent = message;
    group?.classList.toggle('has-error', Boolean(message));
    field?.setAttribute('aria-invalid', String(Boolean(message)));
  };

  const validateField = (name) => {
    const field = form.elements[name];
    if (!field) return true;

    const value = String(field.value || '').trim();
    let message = '';

    if (requiredMessages[name] && !value) {
      message = requiredMessages[name];
    } else if (name === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      message = requiredMessages.email;
    }

    setFieldError(name, message);
    return !message;
  };

  ['name', 'email', 'phone', 'projectType', 'projectDetails'].forEach(name => {
    const field = form.elements[name];
    field?.addEventListener('blur', () => validateField(name));
    field?.addEventListener('input', () => {
      if (field.closest('.field-group')?.classList.contains('has-error')) {
        validateField(name);
      }
    });
  });

  details?.addEventListener('input', () => {
    if (detailsCount) detailsCount.textContent = String(details.value.length);
  });

  const setLoading = (loading) => {
    if (!submitButton) return;
    submitButton.classList.toggle('is-loading', loading);
    submitButton.disabled = loading;
    if (buttonLabel) buttonLabel.textContent = loading ? 'Sending' : 'Send inquiry';
  };

  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (status) status.textContent = '';

    const requiredFields = ['name', 'email', 'phone', 'projectType', 'projectDetails'];
    const isValid = requiredFields.map(validateField).every(Boolean);

    if (!isValid) {
      form.querySelector('[aria-invalid="true"]')?.focus();
      return;
    }

    const payload = Object.fromEntries(new FormData(form).entries());
    setLoading(true);

    try {
      const response = await fetch('/api/inquiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result.error || 'Your inquiry could not be sent. Please try again.');
      }

      form.hidden = true;
      successPanel.hidden = false;
      successPanel.focus?.();
      window.scrollTo({ top: Math.max(0, successPanel.getBoundingClientRect().top + window.scrollY - 140), behavior: 'smooth' });
    } catch (error) {
      if (status) {
        status.textContent = `${error.message} You can also email kirby@perlertechnologies.com.`;
      }
    } finally {
      setLoading(false);
    }
  });
})();
