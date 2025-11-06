window.addEventListener('load', function() {
  setTimeout(() => {
    document.querySelectorAll('.opblock').forEach(block => {
      const json = block.__reactProps$;
      if (!json) return;
      
      // Look for x-roles
      const opData = json?.children?.props?.operation || {};
      const roles = opData['x-roles'] || opData['x_roles'];
      if (roles && Array.isArray(roles)) {
        const badge = document.createElement('span');
        badge.textContent = '[' + roles.join(', ') + ']';
        badge.className = 'role-badge';
        badge.style.cssText = `
          margin-left: 8px;
          padding: 2px 6px;
          border-radius: 8px;
          background: #e0e0e0;
          font-size: 0.8em;
        `;
        const summary = block.querySelector('.opblock-summary');
        if (summary) summary.appendChild(badge);
      }
    });
  }, 1000);
});
