import { HapticType, HomeAssistant } from '../models/interfaces';

import { renderTemplate } from 'ha-nunjucks';
import { CSSResult, LitElement, css, html } from 'lit';
import {
	customElement,
	eventOptions,
	property,
	state,
} from 'lit/decorators.js';

import { UPDATE_AFTER_ACTION_DELAY } from '../models/constants';
import { ActionType, IAction, IActions, IEntry } from '../models/interfaces';
import { deepGet, deepSet, getDeepKeys } from '../utils';

@customElement('base-custom-feature')
export class BaseCustomFeature extends LitElement {
	@property() hass!: HomeAssistant;
	@property() config!: IEntry;

	@state() value?: string | number | boolean = 0;
	entityId?: string;
	valueAttribute?: string;
	getValueFromHass: boolean = true;
	getValueFromHassTimer?: ReturnType<typeof setTimeout>;
	valueUpdateInterval?: ReturnType<typeof setInterval>;

	unitOfMeasurement: string = '';
	precision?: number;

	buttonPressStart?: number;
	buttonPressEnd?: number;
	fireMouseEvent?: boolean = true;

	swiping: boolean = false;
	initialX?: number;
	initialY?: number;

	rtl: boolean = false;

	fireHapticEvent(haptic: HapticType) {
		if (
			this.renderTemplate(this.config.haptics as unknown as string) ??
			false
		) {
			const event = new Event('haptic', {
				bubbles: true,
				composed: true,
			});
			event.detail = haptic;
			window.dispatchEvent(event);
		}
	}

	endAction() {
		clearInterval(this.valueUpdateInterval);
		this.valueUpdateInterval = undefined;

		this.buttonPressStart = undefined;
		this.buttonPressEnd = undefined;

		this.swiping = false;
		this.initialX = undefined;
		this.initialY = undefined;
	}

	sendAction(
		actionType: ActionType,
		actions: IActions = this.config as IActions,
	) {
		let action;
		switch (actionType) {
			case 'momentary_start_action':
				action = actions.momentary_start_action;
				break;
			case 'momentary_end_action':
				action = actions.momentary_end_action;
				break;
			case 'hold_action':
				action = actions.hold_action ?? actions.tap_action;
				break;
			case 'double_tap_action':
				action = actions.double_tap_action ?? actions.tap_action;
				break;
			case 'tap_action':
			default:
				action = actions.tap_action;
				break;
		}

		action &&= this.deepRenderTemplate(action);
		if (!action || !this.handleConfirmation(action)) {
			this.dispatchEvent(new CustomEvent('confirmation-failed'));
			return;
		}

		try {
			switch (action.action) {
				case 'navigate':
					this.navigate(action);
					break;
				case 'url':
					this.url(action);
					break;
				case 'assist':
					this.assist(action);
					break;
				case 'more-info':
					this.moreInfo(action);
					break;
				case 'toggle':
					this.toggle(action);
					break;
				case 'call-service' as 'perform-action': // deprecated in 2024.8
				case 'perform-action':
					this.callService(action);
					break;
				case 'fire-dom-event':
					this.fireDomEvent(action);
					break;
				case 'eval':
					this.eval(action);
					break;
				case 'repeat':
				case 'none':
				default:
					break;
			}
		} catch (e) {
			this.endAction();
			throw e;
		}
	}

	callService(action: IAction) {
		const [domain, service] = (
			action.perform_action ??
			(action['service' as 'perform_action'] as string)
		).split('.');
		this.hass.callService(domain, service, action.data, action.target);
	}

	navigate(action: IAction) {
		const path = (action.navigation_path as string) ?? '';
		const replace = action.navigation_replace ?? false;
		if (path.includes('//')) {
			console.error(
				'Protocol detected in navigation path. To navigate to another website use the action "url" with the key "url_path" instead.',
			);
			return;
		}
		if (replace == true) {
			window.history.replaceState(
				window.history.state?.root ? { root: true } : null,
				'',
				path,
			);
		} else {
			window.history.pushState(null, '', path);
		}
		const event = new Event('location-changed', {
			bubbles: false,
			cancelable: true,
			composed: false,
		});
		event.detail = { replace: replace == true };
		window.dispatchEvent(event);
	}

	url(action: IAction) {
		let url = action.url_path ?? '';
		if (!url.includes('//')) {
			url = `https://${url}`;
		}
		window.open(url);
	}

	assist(action: IAction) {
		// eslint-disable-next-line
		// @ts-ignore
		if (this.hass?.auth?.external?.config?.hasAssist) {
			// eslint-disable-next-line
			// @ts-ignore
			this.hass?.auth?.external?.fireMessage({
				type: 'assist/show',
				payload: {
					pipeline_id: action.pipeline_id,
					start_listening: action.start_listening,
				},
			});
		} else {
			window.open(`${window.location.href}?conversation=1`, '_self');
			// TODO figure out how to make this work on desktop browsers
			// const event = new Event('show-dialog', {
			// 	bubbles: true,
			// 	cancelable: true,
			// 	composed: true,
			// });
			// event.detail = {
			// 	dialogTag: 'ha-voice-command-dialog',
			// 	dialogImport: () =>
			// 		Object.getPrototypeOf(
			// 			document.createElement('ha-voice-command-dialog'),
			// 		),
			// 	dialogParams: {
			// 		pipeline_id: pipelineId ?? 'last_used',
			// 		start_listening: startListening ?? false,
			// 	},
			// };
			// this.dispatchEvent(event);
		}
	}

	moreInfo(action: IAction) {
		const event = new Event('hass-more-info', {
			bubbles: true,
			cancelable: true,
			composed: true,
		});
		event.detail = { entityId: action.target?.entity_id };
		this.dispatchEvent(event);
	}

	toggle(action: IAction) {
		const target = {
			...action.data,
			...action.target,
		};

		if (Array.isArray(target.entity_id)) {
			for (const entityId of target.entity_id) {
				this.toggleSingle(entityId);
			}
		} else if (target.entity_id) {
			this.toggleSingle(target.entity_id);
		} else {
			this.hass.callService('homeassistant', 'toggle', target);
		}
	}

	toggleSingle(entityId: string) {
		const turnOn = ['closed', 'locked', 'off'].includes(
			this.hass.states[entityId].state,
		);
		let domain = entityId.split('.')[0];
		let service: string;
		switch (domain) {
			case 'lock':
				service = turnOn ? 'unlock' : 'lock';
				break;
			case 'cover':
				service = turnOn ? 'open_cover' : 'close_cover';
				break;
			case 'button':
				service = 'press';
				break;
			case 'input_button':
				service = 'press';
				break;
			case 'scene':
				service = 'turn_on';
				break;
			case 'valve':
				service = turnOn ? 'open_valve' : 'close_valve';
				break;
			default:
				domain = 'homeassistant';
				service = turnOn ? 'turn_on' : 'turn_off';
				break;
		}
		this.hass.callService(domain, service, { entity_id: entityId });
	}

	fireDomEvent(action: IAction) {
		const event = new Event(action.event_type ?? 'll-custom', {
			composed: true,
			bubbles: true,
		});
		event.detail = action;
		this.dispatchEvent(event);
	}

	eval(action: IAction) {
		eval(action.eval ?? '');
	}

	handleConfirmation(action: IAction): boolean {
		if (action.confirmation) {
			let text = `Are you sure you want to run action '${action.action}'?`;
			if (action.confirmation == true) {
				this.fireHapticEvent('warning');
				return confirm(text);
			}
			if (action.confirmation?.text) {
				text = action.confirmation.text;
			}
			if (
				action.confirmation?.exemptions
					?.map((exemption) => exemption.user)
					.includes(this.hass.user?.id as string)
			) {
				return true;
			}
			this.fireHapticEvent('warning');
			return confirm(text);
		}
		return true;
	}

	firstUpdated() {
		this.addEventListener('confirmation-failed', this.confirmationFailed);
	}

	confirmationFailed() {
		clearTimeout(this.getValueFromHassTimer);
		this.getValueFromHass = true;
		this.requestUpdate();
	}

	setValue() {
		this.entityId = this.renderTemplate(
			this.config.entity_id as string,
		) as string;

		this.unitOfMeasurement =
			(this.renderTemplate(
				this.config.unit_of_measurement as string,
			) as string) ?? '';

		if (this.getValueFromHass && this.entityId) {
			clearInterval(this.valueUpdateInterval);
			this.valueUpdateInterval = undefined;

			if (this.config.value_template) {
				let value = this.renderTemplate(this.config.value_template);
				if (value !== undefined) {
					this.value = value;
					return;
				}
			}

			this.valueAttribute = (
				this.renderTemplate(
					(this.config.value_attribute as string) ?? 'state',
				) as string
			).toLowerCase();
			if (!this.hass.states[this.entityId]) {
				this.value = undefined;
			} else if (this.valueAttribute == 'state') {
				this.value = this.hass.states[this.entityId].state;
			} else {
				let value:
					| string
					| number
					| boolean
					| string[]
					| number[]
					| undefined;
				const indexMatch = this.valueAttribute.match(/\[\d+\]$/);
				if (indexMatch) {
					const index = parseInt(indexMatch[0].replace(/\[|\]/g, ''));
					this.valueAttribute = this.valueAttribute.replace(
						indexMatch[0],
						'',
					);
					value =
						this.hass.states[this.entityId].attributes[
							this.valueAttribute
						];
					if (value && Array.isArray(value) && value.length) {
						value = value[index];
					} else {
						value = undefined;
					}
				} else {
					value =
						this.hass.states[this.entityId].attributes[
							this.valueAttribute
						];
				}

				if (value != undefined || this.valueAttribute == 'elapsed') {
					switch (this.valueAttribute) {
						case 'brightness':
							this.value = Math.round(
								(100 * parseInt((value as string) ?? 0)) / 255,
							);
							break;
						case 'media_position':
							try {
								const setIntervalValue = () => {
									if (
										this.hass.states[
											this.entityId as string
										].state == 'playing'
									) {
										this.value = Math.min(
											Math.floor(
												Math.floor(value as number) +
													(Date.now() -
														Date.parse(
															this.hass.states[
																this
																	.entityId as string
															].attributes
																.media_position_updated_at,
														)) /
														1000,
											),
											Math.floor(
												this.hass.states[
													this.entityId as string
												].attributes.media_duration,
											),
										);
									} else {
										this.value = value as number;
									}
								};

								setIntervalValue();
								this.valueUpdateInterval = setInterval(
									setIntervalValue,
									500,
								);
							} catch (e) {
								console.error(e);
								this.value = value as string | number | boolean;
							}
							break;
						case 'elapsed':
							if (this.entityId.startsWith('timer.')) {
								if (
									this.hass.states[this.entityId as string]
										.state == 'idle'
								) {
									this.value = 0;
								} else {
									const durationHMS =
										this.hass.states[
											this.entityId as string
										].attributes.duration.split(':');
									const durationSeconds =
										parseInt(durationHMS[0]) * 3600 +
										parseInt(durationHMS[1]) * 60 +
										parseInt(durationHMS[2]);
									const endSeconds = Date.parse(
										this.hass.states[
											this.entityId as string
										].attributes.finishes_at,
									);
									try {
										const setIntervalValue = () => {
											if (
												this.hass.states[
													this.entityId as string
												].state == 'active'
											) {
												const remainingSeconds =
													(endSeconds - Date.now()) /
													1000;
												const value = Math.floor(
													durationSeconds -
														remainingSeconds,
												);
												this.value = Math.min(
													value,
													durationSeconds,
												);
											} else {
												const remainingHMS =
													this.hass.states[
														this.entityId as string
													].attributes.remaining.split(
														':',
													);
												const remainingSeconds =
													parseInt(remainingHMS[0]) *
														3600 +
													parseInt(remainingHMS[1]) *
														60 +
													parseInt(remainingHMS[2]);
												this.value = Math.floor(
													durationSeconds -
														remainingSeconds,
												);
											}
										};

										setIntervalValue();
										this.valueUpdateInterval = setInterval(
											setIntervalValue,
											500,
										);
									} catch (e) {
										console.error(e);
										this.value = 0;
									}
								}
								break;
							}
						// falls through
						default:
							this.value = value as string | number | boolean;
							break;
					}
				} else {
					this.value = value;
				}
			}
		}
	}

	renderTemplate(
		str: string | number | boolean,
		context?: object,
	): string | number | boolean {
		let holdSecs: number = 0;
		if (this.buttonPressStart && this.buttonPressEnd) {
			holdSecs = (this.buttonPressEnd - this.buttonPressStart) / 1000;
		}

		context = {
			VALUE: this.value as string,
			HOLD_SECS: holdSecs,
			UNIT: this.unitOfMeasurement,
			value: this.value as string,
			hold_secs: holdSecs,
			unit: this.unitOfMeasurement,
			config: {
				...this.config,
				entity: this.entityId,
				attribute: this.valueAttribute,
			},
			...context,
		};
		context = {
			render: (str2: string) => this.renderTemplate(str2, context),
			...context,
		};

		let value: string | number = context['value' as keyof typeof context];
		if (
			value != undefined &&
			typeof value == 'number' &&
			this.precision != undefined
		) {
			value = Number(value).toFixed(this.precision);
			context = {
				...context,
				VALUE: value,
				value: value,
			};
		}

		const res = renderTemplate(this.hass, str as string, context);
		if (res != str) {
			return res;
		}

		// Legacy string interpolation
		if (typeof str == 'string') {
			for (const key of ['VALUE', 'HOLD_SECS', 'UNIT']) {
				if (str == key) {
					return context[key as keyof object] as string;
				} else if (str.includes(key)) {
					str = str.replace(
						new RegExp(key, 'g'),
						(context[key as keyof object] ?? '') as string,
					);
				}
			}
		}

		return str;
	}

	deepRenderTemplate<T extends object>(obj: T, context?: object): T {
		const res = structuredClone(obj);
		const keys = getDeepKeys(res);
		for (const key of keys) {
			deepSet(
				res,
				key,
				this.renderTemplate(
					deepGet(res, key) as unknown as string,
					context,
				),
			);
		}
		return res;
	}

	resetGetValueFromHass() {
		const valueFromHassDelay = this.renderTemplate(
			this.config.value_from_hass_delay ?? UPDATE_AFTER_ACTION_DELAY,
		) as number;
		this.getValueFromHassTimer = setTimeout(() => {
			this.getValueFromHass = true;
			this.requestUpdate();
		}, valueFromHassDelay);
	}

	buildStyles(entry: IEntry = this.config, context?: object) {
		return entry.styles
			? html`
					<style>
						${(this.renderTemplate(entry.styles, context) as string)
							.replace(/ !important/g, '')
							.replace(/;/g, ' !important;')}
					</style>
				`
			: '';
	}

	buildBackground() {
		return html` <div class="background"></div>`;
	}

	buildIcon(entry: IEntry = this.config, context?: object) {
		let icon = html``;
		if (entry.icon) {
			icon = html`<ha-icon
				class="icon"
				.icon=${this.renderTemplate(entry.icon as string, context)}
			></ha-icon>`;
		}
		return icon;
	}

	buildLabel(entry: IEntry = this.config, context?: object) {
		if (entry.label) {
			const text: string = this.renderTemplate(
				entry.label as string,
				context,
			) as string;
			if (text) {
				return html`<pre class="label">${text}</pre>`;
			}
		}
		return '';
	}

	// Skeletons for overridden event handlers
	onStart(_e: MouseEvent | TouchEvent) {}
	onEnd(_e: MouseEvent | TouchEvent) {}
	onMove(_e: MouseEvent | TouchEvent) {}

	@eventOptions({ passive: true })
	onMouseDown(e: MouseEvent | TouchEvent) {
		if (this.fireMouseEvent) {
			this.onStart(e);
		}
	}
	onMouseUp(e: MouseEvent | TouchEvent) {
		if (this.fireMouseEvent) {
			this.onEnd(e);
		}
		this.fireMouseEvent = true;
	}
	@eventOptions({ passive: true })
	onMouseMove(e: MouseEvent | TouchEvent) {
		if (this.fireMouseEvent) {
			this.onMove(e);
		}
	}

	@eventOptions({ passive: true })
	onTouchStart(e: TouchEvent) {
		this.fireMouseEvent = false;
		this.onStart(e);
	}
	onTouchEnd(e: TouchEvent) {
		this.fireMouseEvent = false;
		this.onEnd(e);
	}
	@eventOptions({ passive: true })
	onTouchMove(e: TouchEvent) {
		this.fireMouseEvent = false;
		this.onMove(e);
	}

	onContextMenu(e: PointerEvent) {
		if (!this.fireMouseEvent) {
			e.preventDefault();
			e.stopPropagation();
			return false;
		}
	}

	static get styles(): CSSResult | CSSResult[] {
		return css`
			:host {
				display: flex;
				flex-flow: column;
				place-content: center space-evenly;
				align-items: center;
				position: relative;
				height: var(--feature-height, 40px);
				width: 100%;
				border: none;
				border-radius: var(--feature-border-radius, 12px);
				padding: 0px;
				box-sizing: border-box;
				outline: 0px;
				overflow: hidden;
				font-size: inherit;
				color: inherit;
				flex-basis: 100%;
				-webkit-tap-highlight-color: transparent;
				-webkit-tap-highlight-color: rgba(0, 0, 0, 0);
			}

			.container {
				all: inherit;
				overflow: hidden;
				height: 100%;
			}

			.background {
				position: absolute;
				width: inherit;
				height: var(--background-height, 100%);
				background: var(
					--background,
					var(--color, var(--disabled-color))
				);
				opacity: var(--background-opacity, 0.2);
			}

			.icon {
				position: relative;
				pointer-events: none;
				display: inline-flex;
				flex-flow: column;
				place-content: center;
				color: var(--icon-color, inherit);
				filter: var(--icon-filter, inherit);
			}

			.label {
				position: relative;
				pointer-events: none;
				display: inline-flex;
				justify-content: center;
				align-items: center;
				height: 15px;
				line-height: 15px;
				width: inherit;
				margin: 0;
				font-family: inherit;
				font-size: 12px;
				font-weight: bold;
				color: var(--label-color, inherit);
				filter: var(--label-filter, none);
			}
		`;
	}
}
