'use strict';

var async = require('async');
var db = require('../database');
var LRU = require('lru-cache');

module.exports = function (User) {
	User.blocks = {
		_cache: LRU({
			max: 100,
			length: function () { return 1; },
			maxAge: 0,
		}),
	};

	User.blocks.is = function (targetUid, uid, callback) {
		User.blocks.list(uid, function (err, blocks) {
			callback(err, blocks.includes(parseInt(targetUid, 10)));
		});
	};

	User.blocks.list = function (uid, callback) {
		if (User.blocks._cache.has(uid)) {
			return setImmediate(callback, null, User.blocks._cache.get(uid));
		}

		db.getSortedSetRange('uid:' + uid + ':blocked_uids', 0, -1, function (err, blocked) {
			if (err) {
				return callback(err);
			}

			blocked = blocked.map(uid => parseInt(uid, 10)).filter(Boolean);
			User.blocks._cache.set(uid, blocked);
			callback(null, blocked);
		});
	};

	User.blocks.add = function (targetUid, uid, callback) {
		async.waterfall([
			async.apply(this.stateCheck, true, targetUid, uid),
			async.apply(db.sortedSetAdd.bind(db), 'uid:' + uid + ':blocked_uids', Date.now(), targetUid),
			async.apply(User.incrementUserFieldBy, uid, 'blocksCount', 1),
			function (_blank, next) {
				User.blocks._cache.del(uid);
				setImmediate(next);
			},
			async.apply(User.blocks.list, uid),
		], callback);
	};

	User.blocks.remove = function (targetUid, uid, callback) {
		async.waterfall([
			async.apply(this.stateCheck, false, targetUid, uid),
			async.apply(db.sortedSetRemove.bind(db), 'uid:' + uid + ':blocked_uids', targetUid),
			async.apply(User.decrementUserFieldBy, uid, 'blocksCount', 1),
			function (_blank, next) {
				User.blocks._cache.del(uid);
				setImmediate(next);
			},
			async.apply(User.blocks.list, uid),
		], callback);
	};

	User.blocks.stateCheck = function (block, targetUid, uid, callback) {
		User.blocks.is(targetUid, uid, function (err, is) {
			callback(err || (is === block ? new Error('[[error:already-' + (block ? 'blocked' : 'unblocked') + ']]') : null));
		});
	};

	User.blocks.filter = function (uid, property, set, callback) {
		// Given whatever is passed in, iterates through it, and removes entries made by blocked uids
		// property is optional
		if (Array.isArray(property) && typeof set === 'function' && !callback) {
			callback = set;
			set = property;
			property = 'uid';
		}

		if (!Array.isArray(set) || !(set[0].hasOwnProperty(property) || typeof set[0] === 'number' || typeof set[0] === 'string')) {
			return callback(null, set);
		}

		const isPlain = typeof set[0] !== 'object';
		User.blocks.list(uid, function (err, blocked_uids) {
			if (err) {
				return callback(err);
			}

			set = set.filter(function (item) {
				return !blocked_uids.includes(parseInt(isPlain ? item : item[property], 10));
			});

			callback(null, set);
		});
	};
};
