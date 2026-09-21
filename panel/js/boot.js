// Opens the page from the URL once everything above is loaded.
showPage(pageFromPath(), { replace: location.pathname === `${BASE}/` || location.pathname === BASE });
