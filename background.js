/*
 * Copyright (C) 2018 Guido Berhoerster <guido+set-aside@berhoerster.name>
 * Copyright (C) 2021 Tim Schumacher <timschumi@gmx.de>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

const SUPPORTED_PROTOCOLS = ['https:', 'http:', 'ftp:'];
const GROUP_KEY_RE = /^collection:[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const FIREFOX_VERSION_RE = /^(\d+(?:\.\d+)*)(?:([ab]|pre)(\d+))?$/;
const FIREFOX_RELEASE_TYPES = {
    'a': 'alpha',
    'b': 'beta',
    'pre': 'prerelease',
    '': ''
}
const THUMBNAIL_WIDTH = 224;
const THUMBNAIL_HEIGHT = 128;

var tabCollectionsProxy;

function generateUuidV4String() {
    let uuid = new Uint8Array(16);
    window.crypto.getRandomValues(uuid);
    uuid[6] = (uuid[6] & 0x0f) | 0x40;
    uuid[8] = (uuid[8] & 0x3f) | 0x80;

    let result = [];
    for (let i = 0; i < uuid.length; i++) {
        if (i == 4 || i == 6 || i == 8 || i == 10) {
            result.push('-');
        }
        result.push(uuid[i].toString(16).padStart(2, '0'));
    }

    return result.join('');
}

function parseFirefoxVersion(firefoxVersionString) {
    let [, versionString, releaseTypeAbbrev = '', releaseNumberString = '0'] =
            FIREFOX_VERSION_RE.exec(firefoxVersionString);

    let releaseType = FIREFOX_RELEASE_TYPES[releaseTypeAbbrev];

    let releaseNumber = parseInt(releaseNumberString);
    let [major = 0, minor = 0, patch = 0] = versionString.split('.')
            .map(x => parseInt(x));

    return {
        major,
        minor,
        patch,
        releaseType,
        releaseNumber,
    };
}

class ObjectStoreDB {
    constructor(dbName = 'defaultDatabase', objectStoreName = 'objectStore') {
        this.dbName = dbName;
        this.objectStoreName = objectStoreName;
        this._db = undefined;
        this.openingDB = new Promise((resolve, reject) => {
            let request = indexedDB.open(this.dbName);
            request.addEventListener('error', ev => {
                reject(request.error);
            });
            request.addEventListener('success', ev => {
                resolve(request.result);
            });
            request.addEventListener('upgradeneeded', ev => {
                request.result.createObjectStore(this.objectStoreName);
            });
        });
    }

    async _execTransaction(method, ...methodArguments) {
        if (typeof this._db === 'undefined') {
            this._db = await this.openingDB;
        }
        return new Promise((resolve, reject) => {
            let transaction = this._db.transaction(this.objectStoreName,
                    method.startsWith('get') ? 'readonly' : 'readwrite');
            let objectStore = transaction.objectStore(this.objectStoreName);
            let request = objectStore[method](...methodArguments);
            transaction.addEventListener('complete', ev =>
                    method.startsWith('get') ?
                    resolve(request.result) :
                    resolve());
            transaction.addEventListener('abort', ev =>
                    reject(transaction.error));
            transaction.addEventListener('error', ev =>
                    reject(transaction.error));
        });
    }

    async get(key) {
        return key === null || typeof key === 'undefined' ?
                this._execTransaction('getAll') :
                this._execTransaction('get', key);
    }

    async keys() {
        return this._execTransaction('getAllKeys');
    }

    async set(key, value) {
        return this._execTransaction('put', value, key)
    }

    async delete(key) {
        return this._execTransaction('delete', key)
    }

    async clear(key) {
        return this._execTransaction('clear')
    }
}

class Tab {
    static deserialize(object) {
        return new Tab(object);
    }

    constructor({url, title, uuid = generateUuidV4String(), favIcon = null,
            thumbnail = null}) {
        this.uuid = uuid;
        this.url = url;
        this.title = title;
        this.favIcon = favIcon;
        this.thumbnail = thumbnail;
    }

    serialize() {
        return Object.assign({}, this, {favIcon: null, thumbnail: null});
    }
}

class TabCollection {
    static deserialize(object) {
        object.tabs = Array.from(object.tabs,
                ([, tab]) => [tab.uuid, Tab.deserialize(tab)]);
        return new TabCollection(object);
    }

    constructor({tabs, uuid = generateUuidV4String(), date = new Date()}) {
        this.uuid = uuid;
        this.date = new Date(date);
        this.tabs = new Map();
        // allow any type which allows iteration
        for (let [, tab] of tabs) {
            this.tabs.set(tab.uuid, tab);
        }
    }

    serialize() {
        let serializedTabs = [];
        for (let [tabUuid, tab] of this.tabs) {
            serializedTabs.push([tab.uuid, tab.serialize()]);
        }
        return {
            uuid: this.uuid,
            date: this.date.toJSON(),
            tabs: serializedTabs
        };
    }
}

class TabCollectionsStorageProxy {
    constructor() {
        this.tabCollections = new Map();
        this.objectStoreDB = new ObjectStoreDB('tabCollections');
        this.ports = new Set();
        this.browserVersion = undefined;
        this.messageQueue = [];
        this.isInitialized = false;

        browser.runtime.onConnect.addListener(this.onConnect.bind(this));
    }

    async init() {
        let browserInfo = await browser.runtime.getBrowserInfo();
        this.browserVersion = parseFirefoxVersion(browserInfo.version);

        // get all tab collections and deserialize them in a Map
        let storageEntries = Object.entries(await browser.storage.sync.get())
                .filter(([key, value]) => GROUP_KEY_RE.test(key))
                .map(([key, tabCollection]) =>
                [tabCollection.uuid, TabCollection.deserialize(tabCollection)]);
        this.tabCollections = new Map(storageEntries);
        console.log('tab collections from storage');
        console.table(this.tabCollections);
        console.groupEnd();
        browser.storage.onChanged.addListener(this.onStorageChanged.bind(this));

        // get favicon and thumbnail data from local database
        let updatingTabData = [];
        for (let tabCollectionUuid of this.tabCollections.keys()) {
            updatingTabData.push(this.updateTabData(tabCollectionUuid));
        }
        await Promise.all(updatingTabData);

        // remove stale data from local database
        for (let tabCollectionUuid of await this.objectStoreDB.keys()) {
            if (!this.tabCollections.has(tabCollectionUuid)) {
                console.log('removing data for stale tab collection',
                    tabCollectionUuid);
                this.objectStoreDB.delete(tabCollectionUuid);
            }
        }

        this.isInitialized = true;

        while (this.messageQueue.length > 0) {
            let [message, port] = this.messageQueue.pop();
            if (this.ports.has(port)) {
                this.onMessage(message, port);
            }
        }
    }

    async createTabThumbnail(tabId) {
        let captureUrl = await browser.tabs.captureTab(tabId);
        let thumbnailBlob = await new Promise((resolve, reject) => {
            let image = new Image();
            image.addEventListener('load', ev => {
                let canvas = document.createElement('canvas');
                canvas.width = THUMBNAIL_WIDTH;
                canvas.height = THUMBNAIL_HEIGHT;
                let dWidth = canvas.width;
                let dHeight = dWidth * (image.height / image.width);

                let ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(image, 0, 0, dWidth, dHeight);

                canvas.toBlob(resolve, 'image/jpeg', 0.75);
            });
            image.addEventListener('error', e => {
                reject(e);
            });
            image.src = captureUrl;
        });
        return thumbnailBlob;
    }

    async createTabCollection(windowId) {
        let browserTabs = await browser.tabs.query({
            windowId,
            hidden: false,
            pinned:false
        });

        // sanity check to prevent saving tabs from incognito windows
        if (browserTabs.length === 0 || browserTabs[0].incognito) {
            return;
        }

        // filter out tabs which cannot be restored
        browserTabs = browserTabs.filter(browserTab =>
                SUPPORTED_PROTOCOLS.includes(new URL(browserTab.url).protocol));
        if (browserTabs.length === 0) {
            return;
        }

        let tabs = await Promise.all(browserTabs.map(async browserTab => {
            // convert favicon data URI to blob
            let favIcon = null;
            if (!browserTab.discarded) {
                try {
                    let response = await fetch(browserTab.favIconUrl);
                    favIcon = await response.blob();
                } catch (e) {
                    if (!(e instanceof AbortError)) {
                        throw e;
                    }
                }
            }

            let tab = new Tab({
                url: browserTab.url,
                title: browserTab.title,
                favIcon
            });
            return [tab.uuid, tab];
        }));

        // create empty tab which becomes the new active tab
        await browser.tabs.create({active: true});

        // capture tabs, return null for discarded tabs since they can only be
        // captured after they have been restored, e.g. through user
        // interaction, and thus might hang the capture process indefinetly
        let thumbnails = await Promise.all(browserTabs.map(browserTab =>
                !browserTab.discarded ?
                this.createTabThumbnail(browserTab.id) : null));
        for (let [, tab] of tabs) {
            tab.thumbnail = thumbnails.shift();
        }

        let tabCollection = new TabCollection({tabs});
        console.log('created tab collection:', tabCollection);

        // store tab favicons and thumbnails
        let tabCollectionData = {
            uuid: tabCollection.uuid,
            tabs: new Map()
        };
        for (let [uuid, tab] of tabs) {
            tabCollectionData.tabs.set(uuid, {
                favIcon: tab.favIcon,
                thumbnail: tab.thumbnail
            });
        }
        await this.objectStoreDB.set(tabCollectionData.uuid, tabCollectionData);

        // store tab collection
        console.log('storing tab collection:', tabCollection);
        await browser.storage.sync.set({
            [`collection:${tabCollection.uuid}`]: tabCollection.serialize()
        });

        // remove tabs
        await browser.tabs.remove(browserTabs.map(browserTab => browserTab.id));
    }

    async removeTab(tabCollectionUuid, tabUuid) {
        console.log('removing tab %s from collection %s', tabUuid,
                tabCollectionUuid);
        let tabCollection = this.tabCollections.get(tabCollectionUuid);
        // create shallow clone
        let newTabCollection = new TabCollection(tabCollection);
        newTabCollection.tabs.delete(tabUuid);
        // remove tab collection if there are no more tabs
        if (newTabCollection.tabs.size === 0) {
            return this.removeTabCollection(tabCollectionUuid);
        }
        await browser.storage.sync.set({
            [`collection:${tabCollectionUuid}`]: newTabCollection.serialize()
        });
    }

    async restoreTab(tabCollectionUuid, tabUuid, windowId) {
        console.log('restoring tab %s from collection %s in window %d', tabUuid,
                tabCollectionUuid, windowId);
        let tab = this.tabCollections.get(tabCollectionUuid).tabs.get(tabUuid);
        let tabProperties = {
            active: false,
            url: tab.url,
            windowId
        };
        if (this.browserVersion.major >= 63) {
            tabProperties.discarded = true;
        }
        await browser.tabs.create(tabProperties);
        await this.removeTab(tabCollectionUuid, tabUuid);
    }

    async removeTabCollection(tabCollectionUuid) {
        console.log('removing tab collection %s', tabCollectionUuid);
        await browser.storage.sync.remove(`collection:${tabCollectionUuid}`);
        this.objectStoreDB.delete(tabCollectionUuid);
    }

    async restoreTabCollection(tabCollectionUuid, windowId) {
        console.log('restoring tab collection %s in window %s',
                tabCollectionUuid, windowId);
        let tabProperties = {
            active: false,
            windowId
        };
        if (this.browserVersion.major >= 63) {
            tabProperties.discarded = true;
        }
        let creatingTabs =
                Array.from(this.tabCollections.get(tabCollectionUuid).tabs,
                ([, tab]) => browser.tabs.create(Object.assign({
                    url: tab.url
                }, tabProperties)));
        await Promise.all(creatingTabs);
        await this.removeTabCollection(tabCollectionUuid);
    }

    async updateTabData(tabCollectionUuid) {
        let tabCollectionDataObject;
        try {
            tabCollectionDataObject =
                    await this.objectStoreDB.get(tabCollectionUuid);
        } catch (e) {
            console.error(`Failed to get data from database: e.message`);
            return;
        }
        if (typeof tabCollectionDataObject === 'undefined') {
            // does not exist in database
            console.log('no data stored for tab collection', tabCollectionUuid);
            return;
        }

        console.log(`updating tab collection ${tabCollectionUuid} with data`,
                tabCollectionDataObject);
        let tabCollection = this.tabCollections.get(tabCollectionUuid);
        for (let [tabUuid, tab] of tabCollection.tabs) {
            let tabDataObject = tabCollectionDataObject.tabs.get(tabUuid);
            if (typeof tabDataObject === 'undefined') {
                continue;
            }
            tab.favIcon = tabDataObject.favIcon;
            tab.thumbnail = tabDataObject.thumbnail;
        }
    }

    async onStorageChanged(changes, areaName) {
        if (areaName !== 'sync') {
            return;
        }

        console.group('sync storage area changed:', changes);
        console.table(Object.entries(changes)[0][1])
        console.groupEnd();

        let [key, {oldValue, newValue}] = Object.entries(changes)[0];
        if (!GROUP_KEY_RE.test(key)) {
            return;
        }

        let tabCollectionUuid = key.replace('collection:', '');
        if (typeof oldValue === 'undefined') {
            // a new collection was created
            let newTabCollection = TabCollection.deserialize(newValue);
            this.tabCollections.set(tabCollectionUuid, newTabCollection);
            // try to get tab favicons and thumbnails
            await this.updateTabData(tabCollectionUuid);

            this.broadcastMessage({
                type: 'tabCollectionCreated',
                tabCollection: newTabCollection
            });
        } else if (typeof newValue === 'undefined') {
            // a collection has been removed
            this.tabCollections.delete(tabCollectionUuid);
            this.objectStoreDB.delete(tabCollectionUuid);

            this.broadcastMessage({
                type: 'tabCollectionRemoved',
                tabCollectionUuid
            });
        } else {
            // a collection has changed
            let newTabCollection = TabCollection.deserialize(newValue);
            this.tabCollections.set(tabCollectionUuid, newTabCollection);
            // try to get tab favicons and thumbnails
            await this.updateTabData(tabCollectionUuid);

            this.broadcastMessage({
                type: 'tabCollectionChanged',
                tabCollection: newTabCollection
            });
        }
    }

    broadcastMessage(message) {
        for (let port of this.ports) {
            port.postMessage(message);
        }
    }

    onConnect(port) {
        console.log('port connected:', port)
        this.ports.add(port);
        port.onMessage.addListener(this.onMessage.bind(this));
        port.onDisconnect.addListener(this.onDisconnect.bind(this));
    }

    onDisconnect(port) {
        if (port.error) {
            console.log(`port connection error: ${port.error}\n`);
        }
        console.log('port disconnected:', port);
        this.ports.delete(port);
    }

    onMessage(message, port) {
        if (!this.isInitialized) {
            console.log('queued message', message, 'from port', port);
            this.messageQueue.push([message, port]);
            return;
        }

        console.log('received message', message, 'on port', port);
        switch (message.type) {
            case 'getTabCollections':
                port.postMessage({
                    type: 'tabCollections',
                    tabCollections: this.tabCollections
                });
                break;
            case 'removeTab':
                this.removeTab(message.tabCollectionUuid, message.tabUuid);
                break;
            case 'restoreTab':
                this.restoreTab(message.tabCollectionUuid, message.tabUuid,
                        message.windowId);
                break;
            case 'removeTabCollection':
                this.removeTabCollection(message.tabCollectionUuid);
                break;
            case 'restoreTabCollection':
                this.restoreTabCollection(message.tabCollectionUuid,
                        message.windowId);
                break;
        }
    }
}

// browser action context menu entry for opening the sidebar
browser.menus.create({
    contexts: ['browser_action'],
    onclick: (info, tab) => browser.sidebarAction.open(),
    title: browser.i18n.getMessage('showTabsMenuItem')
});

// disable the browser action for incognito tabs
browser.tabs.onCreated.addListener(tab => {
    if (tab.incognito) {
        console.log('created, disabling');
        browser.browserAction.disable(tab.id);
    }
});
browser.tabs.onUpdated.addListener((tabId, details, tab) => {
    if (tab.incognito) {
        console.log('updated, disabling');
        browser.browserAction.disable(tabId);
    }
});

(async () => {
    // disable the browser action for existing incognito tabs
    let tabs = await browser.tabs.query({});
    await Promise.all(tabs.filter(tab => tab.incognito)
            .map(tab => browser.browserAction.disable(tab.id)))

    tabCollectionsProxy = new TabCollectionsStorageProxy();
    await tabCollectionsProxy.init();

    browser.browserAction.onClicked.addListener(async targetTab => {
        // prevent browser action from being activated while a collection is
        // being created
        let tabs = await browser.tabs.query({windowId: targetTab.windowId});
        await Promise.all(tabs.map(tab =>
                browser.browserAction.disable(tab.id)));

        try {
            await tabCollectionsProxy.createTabCollection(targetTab.windowId);
        } catch (e) {
            tabs = await browser.tabs.query({windowId: targetTab.windowId});
            await Promise.all(tabs.map(tab =>
                    browser.browserAction.enable(tab.id)));
            throw e
        }

        tabs = await browser.tabs.query({windowId: targetTab.windowId});
        await Promise.all(tabs.map(tab =>
                browser.browserAction.enable(tab.id)));
    });
})();
