import { Meteor } from 'meteor/meteor';
import { TAPi18n } from 'meteor/rocketchat:tap-i18n';

import { FileUpload } from '../../../file-upload';
import { Users, Subscriptions, Messages, Rooms, Integrations, FederationServers } from '../../../models';
import { hasRole, getUsersInRole, addUserRoles } from '../../../authorization';
import { settings } from '../../../settings';
import { Notifications } from '../../../notifications';

export const deleteUser = function(userId) {
	const user = Users.findOneById(userId, {
		fields: { username: 1, avatarOrigin: 1, federation: 1 },
	});

	if (user.federation) {
		const existingSubscriptions = Subscriptions.find({ 'u._id': user._id }).count();

		if (existingSubscriptions > 0) {
			throw new Meteor.Error('FEDERATION_Error_user_is_federated_on_rooms');
		}
	}

	// Users without username can't do anything, so there is nothing to remove
	if (user.username != null) {
		const roomCache = [];
		const roomsToRemove = [];

		// Iterate through all the rooms the user is subscribed to, to check if they are the last owner of any of them.
		Subscriptions.db.findByUserId(userId).forEach((subscription) => {
			const roomData = {
				rid: subscription.rid,
				t: subscription.t,
				subscribers: null,
			};

			// If the user is an owner on this room and it's not a DM
			if (roomData.t !== 'd' && hasRole(user._id, 'owner', subscription.rid)) {
				// Fetch the number of owners
				const numOwners = getUsersInRole('owner', subscription.rid).fetch().length;
				// If it's only one, then this user is the only owner.
				if (numOwners === 1) {
					// Let's check how many subscribers the room has.
					const options = { sort: { ts: 1 } };
					const subscribersCursor = Subscriptions.findByRoomId(subscription.rid, options);
					roomData.subscribers = subscribersCursor.count();

					let changedOwner = false;

					subscribersCursor.forEach((subscriber) => {
						if (changedOwner || subscriber.u._id === user._id) {
							return false;
						}

						const newOwner = Users.findOneById(subscriber.u._id);
						if (!newOwner || !newOwner.active) {
							return true;
						}

						addUserRoles(subscriber.u._id, 'owner', subscriber.rid);
						changedOwner = true;
						return false;
					});

					// If there's no subscriber available to be the new owner, we can remove this room.
					if (!changedOwner) {
						roomsToRemove.push(subscription.rid);
					}
				}
			}

			roomCache.push(roomData);
		});

		const messageErasureType = settings.get('Message_ErasureType');
		switch (messageErasureType) {
			case 'Delete':
				const store = FileUpload.getStore('Uploads');
				Messages.findFilesByUserId(userId).forEach(function({ file }) {
					store.deleteById(file._id);
				});
				Messages.removeByUserId(userId);
				break;
			case 'Unlink':
				const rocketCat = Users.findOneById('rocket.cat');
				const nameAlias = TAPi18n.__('Removed_User');
				Messages.unlinkUserId(userId, rocketCat._id, rocketCat.username, nameAlias);
				break;
		}

		roomCache.forEach((roomData) => {
			if (roomData.subscribers === null && roomData.t !== 'd' && roomData.t !== 'c') {
				roomData.subscribers = Subscriptions.findByRoomId(roomData.rid).count();
			}

			// Remove DMs and non-channel rooms with only 1 user (the one being deleted)
			if (roomData.t === 'd' || (roomData.t !== 'c' && roomData.subscribers === 1) || roomsToRemove.includes(roomData.rid)) {
				Subscriptions.removeByRoomId(roomData.rid);
				FileUpload.removeFilesByRoomId(roomData.rid);
				Messages.removeByRoomId(roomData.rid);
				Rooms.removeById(roomData.rid);
			}
		});

		Subscriptions.removeByUserId(userId); // Remove user subscriptions
		Rooms.removeDirectRoomContainingUsername(user.username); // Remove direct rooms with the user

		// removes user's avatar
		if (user.avatarOrigin === 'upload' || user.avatarOrigin === 'url') {
			FileUpload.getStore('Avatars').deleteByName(user.username);
		}

		Integrations.disableByUserId(userId); // Disables all the integrations which rely on the user being deleted.
		Notifications.notifyLogged('Users:Deleted', { userId });
	}

	Users.removeById(userId); // Remove user from users database

	// Refresh the servers list
	FederationServers.refreshServers();
};
