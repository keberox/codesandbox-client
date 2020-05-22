import { Contributor, PermissionType } from '@codesandbox/common/lib/types';
import { hasPermission } from '@codesandbox/common/lib/utils/permission';
import { identify } from '@codesandbox/common/lib/utils/analytics';
import { IDerive, IState } from 'overmind';

import { notificationState } from '@codesandbox/common/lib/utils/notifications';
import { NotificationStatus } from '@codesandbox/notifications';
import { AsyncAction } from '.';

export const TEAM_ID_LOCAL_STORAGE = 'codesandbox-selected-team-id';
/*
  Ensures that we have loaded the app with the initial user
  and settings
*/
export const withLoadApp = <T>(
  continueAction?: AsyncAction<T>
): AsyncAction<T> => async (context, value) => {
  const { effects, state, actions } = context;

  if (state.hasLoadedApp && continueAction) {
    await continueAction(context, value);
    return;
  }
  if (state.hasLoadedApp) {
    return;
  }

  state.isAuthenticating = true;

  effects.connection.addListener(actions.connectionChanged);
  actions.internal.setStoredSettings();
  effects.codesandboxApi.listen(actions.server.onCodeSandboxAPIMessage);

  if (localStorage.jwt) {
    // We've introduced a new way of signing in to CodeSandbox, and we should let the user know to
    // convert to it.

    document.cookie =
      'signedIn=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/;';
    state.hasLogIn = false;
    delete localStorage.jwt;
    notificationState.addNotification({
      title: 'Session Expired',
      sticky: true,
      message:
        'Whoops, your session has been expired! Please sign in again to continue.',
      status: NotificationStatus.NOTICE,
      actions: {
        primary: [
          {
            label: 'Sign in',
            run: () => {
              actions.signInClicked({ useExtraScopes: false });
            },
          },
        ],
      },
    });
  }

  if (state.hasLogIn) {
    try {
      state.user = await effects.api.getCurrentUser();
      actions.internal.setPatronPrice();
      effects.analytics.identify('signed_in', true);
      effects.analytics.setUserId(state.user.id, state.user.email);
      const localStorageTeam = effects.browser.storage.get(
        TEAM_ID_LOCAL_STORAGE
      );
      if (localStorageTeam) {
        state.dashboard.activeTeam = localStorageTeam;
      }
      try {
        actions.internal.trackCurrentTeams();
      } catch (e) {
        // Not majorly important
      }
      actions.internal.showUserSurveyIfNeeded();
      await effects.live.getSocket();
      actions.userNotifications.internal.initialize();
      effects.api.preloadTemplates();
      state.hasLogIn = true;
    } catch (error) {
      actions.internal.handleError({
        message: 'We had trouble with signing you in',
        error,
      });
    }
  } else {
    identify('signed_in', false);
    effects.analytics.setAnonymousId();
  }

  if (continueAction) {
    await continueAction(context, value);
  }

  state.hasLoadedApp = true;
  state.isAuthenticating = false;

  try {
    const response = await effects.http.get<{
      contributors: Contributor[];
    }>(
      'https://raw.githubusercontent.com/codesandbox/codesandbox-client/master/.all-contributorsrc'
    );

    state.contributors = response.data.contributors.map(
      contributor => contributor.login
    );
  } catch (error) {
    // Something wrong in the parsing probably, make sure the file is JSON valid
  }
};

export const withOwnedSandbox = <T>(
  continueAction: AsyncAction<T>,
  cancelAction: AsyncAction<T> = () => Promise.resolve(),
  requiredPermission?: PermissionType
): AsyncAction<T> => async (context, payload) => {
  const { state, actions } = context;

  const sandbox = state.editor.currentSandbox;
  if (sandbox) {
    if (
      typeof requiredPermission === 'undefined'
        ? !sandbox.owned
        : !hasPermission(sandbox.authorization, requiredPermission)
    ) {
      if (state.editor.isForkingSandbox) {
        return cancelAction(context, payload);
      }

      try {
        await actions.editor.internal.forkSandbox({
          sandboxId: sandbox.id,
        });
      } catch (e) {
        return cancelAction(context, payload);
      }
    } else if (sandbox.isFrozen && state.editor.sessionFrozen) {
      const modalResponse = await actions.modals.forkFrozenModal.open();

      if (modalResponse === 'fork') {
        try {
          await actions.editor.internal.forkSandbox({
            sandboxId: sandbox.id,
          });
        } catch (e) {
          return cancelAction(context, payload);
        }
      } else if (modalResponse === 'unfreeze') {
        state.editor.sessionFrozen = false;
      } else if (modalResponse === 'cancel') {
        return cancelAction(context, payload);
      }
    }
  }

  return continueAction(context, payload);
};

export const createModals = <
  T extends {
    [name: string]: {
      state?: IState;
      result?: unknown;
    };
  }
>(
  modals: T
): {
  state: {
    current: keyof T | null;
  } & {
    [K in keyof T]: T[K]['state'] & { isCurrent: IDerive<any, any, boolean> };
  };
  actions: {
    [K in keyof T]: {
      open: AsyncAction<
        T[K]['state'] extends IState ? T[K]['state'] : void,
        T[K]['result']
      >;
      close: AsyncAction<T[K]['result']>;
    };
  };
} => {
  function createModal(name, modal) {
    let resolver;

    const open: AsyncAction<any, any> = async ({ state }, newState = {}) => {
      state.modals.current = name;

      Object.assign(state.modals[name], newState);

      return new Promise(resolve => {
        resolver = resolve;
      });
    };

    const close: AsyncAction<T> = async ({ state }, payload) => {
      state.modals.current = null;
      resolver(payload || modal.result);
    };

    return {
      state: {
        ...modal.state,
        isCurrent(_, root) {
          return root.modals.current === name;
        },
      },
      actions: {
        open,
        close,
      },
    };
  }

  return Object.keys(modals).reduce(
    (aggr, name) => {
      const modal = createModal(name, modals[name]);

      aggr.state[name] = modal.state;
      aggr.actions[name] = modal.actions;

      return aggr;
    },
    {
      state: {
        current: null,
      },
      actions: {},
    }
  ) as any;
};
