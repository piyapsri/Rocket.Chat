import { AdminBox } from '../../ui-admin/client/AdminBox';
import { hasAllPermission } from '../../authorization';

AdminBox.addOption({
	href: 'admin-mailer',
	i18nLabel: 'Mailer',
	icon: 'mail',
	permissionGranted() {
		return hasAllPermission('access-mailer');
	},
});
