/*
 * Copyright (C) 2018 Guido Berhoerster <guido+set-aside@berhoerster.name>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

'use strict';

var tabManager;

class TabManager {
    constructor() {
        this.tabCollectionTemplate =
                document.querySelector('#tab-collection-template');
        this.tabItemTemplate = document.querySelector('#tab-item-template');
        this.tabCollectionsElement = document.querySelector('#tab-collections');
        this.port = browser.runtime.connect({name: 'tab-collection-manager'});
        this.port.onMessage.addListener(this.onMessage.bind(this));
        this.port.onDisconnect.addListener(this.onMessage.bind(this));
        this.port.postMessage({type: 'getTabCollections'});
        this.isInitialized = false;
    }

    initTabCollections(tabCollections) {
        if (this.isInitialized) {
            return;
        }

        for (let tabCollection of tabCollections.values()) {
            this.prependTabCollection(tabCollection);
        }
        this.sortTabCollections();

        document.querySelector('#message').textContent =
                browser.i18n.getMessage('emptySidebarMessage');

        document.body.addEventListener('click', this);

        window.addEventListener('optimizedResize', this);

        this.isInitialized = true;
    }

    createTabCollectionNode(tabCollection) {
        let tabCollectionNode =
                document.importNode(this.tabCollectionTemplate.content, true);

        tabCollectionNode.querySelector('.tab-collection')
                .dataset.tabCollectionUuid = tabCollection.uuid;

        tabCollectionNode.querySelector('.tab-collection-title').textContent =
                browser.i18n.getMessage('collectionTitle',
                tabCollection.tabs.size);

        let tabCollectionCtimeElement =
                tabCollectionNode.querySelector('.tab-collection-ctime');
        tabCollectionCtimeElement.dateTime = tabCollection.date.toISOString();
        tabCollectionCtimeElement.textContent =
                tabCollection.date.toLocaleString();

        let tabCollectionRestoreElement =
                tabCollectionNode.querySelector('.restore-tab-collection');
        tabCollectionRestoreElement.title =
                tabCollectionRestoreElement.textContent =
                browser.i18n.getMessage('restoreTabsButtonTitle');
        tabCollectionNode.querySelector('.remove-tab-collection').title =
                browser.i18n.getMessage('removeTabsButtonTitle');

        let tabListElement =
                tabCollectionNode.querySelector('.tab-collection-tabs');
        for (let tab of tabCollection.tabs.values()) {
            let tabItemNode = document.importNode(this.tabItemTemplate.content,
                    true);

            tabItemNode.querySelector('.tab-item').dataset.tabUuid = tab.uuid;

            let tabLinkElement = tabItemNode.querySelector('.tab-link');
            tabLinkElement.href = tab.url;
            tabLinkElement.title = tab.title;

            if (tab.thumbnail !== null) {
                tabItemNode.querySelector('.tab-thumbnail').src =
                        URL.createObjectURL(tab.thumbnail);
            }

            if (tab.favIcon !== null) {
                tabItemNode.querySelector('.tab-favicon').src =
                        URL.createObjectURL(tab.favIcon);
            }

            tabItemNode.querySelector('.tab-title').textContent = tab.title;

            tabItemNode.querySelector('.remove-tab').title =
                    browser.i18n.getMessage('removeTabTitle');

            tabListElement.append(tabItemNode);
        }

        return tabCollectionNode;
    }

    prependTabCollection(tabCollection) {
        console.log('prepending tab collection', tabCollection,
                'to tab collections');
        this.tabCollectionsElement
                .prepend(this.createTabCollectionNode(tabCollection));
        this.handleResize();
    }

    replaceTabCollection(tabCollection) {
        console.log('replacing tab collection', tabCollection);
        this.tabCollectionsElement.querySelector(`[data-tab-collection-uuid=` +
                `"${tabCollection.uuid}"]`)
                .replaceWith(this.createTabCollectionNode(tabCollection));
        this.handleResize();
    }

    removeTabCollection(tabCollectionUuid) {
        console.log('removing tab collection %s', tabCollectionUuid);
        this.tabCollectionsElement
                .querySelector(`[data-tab-collection-uuid=` +
                `"${tabCollectionUuid}"]`)
                .remove();

        if (this.tabCollectionsElement.childElementCount === 0) {
            // remove any text nodes so that the :empty CSS selectora applies
            while (this.tabCollectionsElement.firstChild !== null) {
                this.tabCollectionsElement
                        .removeChild(this.tabCollectionsElement.firstChild);
            }
        }
    }

    sortTabCollections() {
        Array.from(this.tabCollectionsElement.children)
                .map(element =>
                [element.querySelector('.tab-collection-ctime').dateTime,
                element])
                .sort((a, b) => a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0)
                .forEach(([, element]) =>
                this.tabCollectionsElement.append(element));
    }

    onMessage(message, port) {
        console.log('received message', message, 'on port', port);
        switch (message.type) {
            case 'tabCollections':
                this.initTabCollections(message.tabCollections);
                break;
            case 'tabCollectionCreated':
                this.prependTabCollection(message.tabCollection);
                break;
            case 'tabCollectionRemoved':
                this.removeTabCollection(message.tabCollectionUuid);
                break;
            case 'tabCollectionChanged':
                this.replaceTabCollection(message.tabCollection);
                break;
        }
        this.sortTabCollections();
    }

    handleTabCollectionChanged(tabCollectionContainerElement) {
        let tabsElement = tabCollectionContainerElement
                .querySelector('.tab-collection-tabs');
        let scrollLeftElement = tabCollectionContainerElement
                .querySelector('.scroll-left');
        let scrollRightElement = tabCollectionContainerElement
                .querySelector('.scroll-right');
        if (tabsElement.scrollWidth > tabsElement.clientWidth) {
            scrollLeftElement.classList.add('scroll-visible');
            scrollRightElement.classList.add('scroll-visible');
        } else {
            scrollLeftElement.classList.remove('scroll-visible');
            scrollRightElement.classList.remove('scroll-visible');
        }
    }

    handleResize() {
        let tabCollectionContainerElements =
                document.querySelectorAll('.tab-collection-tabs-container');
        for (let tabCollectionContainerElement of
                tabCollectionContainerElements) {
            this.handleTabCollectionChanged(tabCollectionContainerElement);
        }
    }

    handleEvent(ev) {
        console.log('DOM event', ev);
        if (ev.type === 'click') {
            ev.preventDefault();
            if (ev.target.classList.contains('restore-tab-collection')) {
                // restore tab collection
                let tabCollectionUuid = ev.target.closest('.tab-collection')
                        .dataset.tabCollectionUuid;
                this.port.postMessage({
                    type: 'restoreTabCollection',
                    tabCollectionUuid,
                    windowId: browser.windows.WINDOW_ID_CURRENT
                });
            } else if (ev.target.classList.contains('remove-tab-collection')) {
                // remove tab collection
                let tabCollectionUuid = ev.target.closest('.tab-collection')
                        .dataset.tabCollectionUuid;
                this.port.postMessage({
                    type: 'removeTabCollection',
                    tabCollectionUuid
                });
            } else if (ev.target.classList.contains('remove-tab')) {
                // remove tab from collection
                let tabItemElement = ev.target.closest('.tab-item');
                let tabCollectionUuid =
                        tabItemElement.closest('.tab-collection')
                        .dataset.tabCollectionUuid;
                let tabUuid = tabItemElement.dataset.tabUuid;
                this.port.postMessage({
                    type: 'removeTab',
                    tabCollectionUuid,
                    tabUuid
                });
            } else if (ev.target.classList.contains('tabs-scroll-button')) {
                // scroll tab list
                let tabsElement = ev.target
                        .closest('.tab-collection-tabs-container')
                        .querySelector('.tab-collection-tabs');
                if (ev.target.classList.contains('scroll-left')) {
                    tabsElement.scrollLeft = Math.max(tabsElement.scrollLeft -
                            tabsElement.clientWidth * .75, 0);
                } else {
                    tabsElement.scrollLeft = Math.min(tabsElement.scrollLeft +
                            tabsElement.clientWidth * .75,
                            tabsElement.scrollLeftMax);
                }
            } else {
                let tabItemElement = ev.target.closest('.tab-item');
                if (tabItemElement !== null) {
                    // restore tab from collection
                    let tabCollectionUuid =
                            tabItemElement.closest('.tab-collection')
                            .dataset.tabCollectionUuid;
                    let tabUuid = tabItemElement.dataset.tabUuid;
                    this.port.postMessage({
                        type: 'restoreTab',
                        tabCollectionUuid,
                        tabUuid,
                        windowId: browser.windows.WINDOW_ID_CURRENT
                    });
                }
            }
        } else if (ev.type === 'optimizedResize') {
            // window has been resized
            this.handleResize();
        }
    }
}

browser.windows.getCurrent().then(currentWindow => {
    function throttleResize(type, name, obj) {
        obj = obj || window;
        var isRunning = false;
        var func = function() {
            if (isRunning) {
                return;
            }

            isRunning = true;
            requestAnimationFrame(function() {
                obj.dispatchEvent(new CustomEvent(name));
                isRunning = false;
            });
        };
        obj.addEventListener(type, func);
    };
    throttleResize('resize', 'optimizedResize');

    tabManager = new TabManager();
});
