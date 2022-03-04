import { ReactiveElement, LitElement, html, svg, css } from '/wildtype/lit.js';
import { msg, updateWhenLocaleChanges, localeList, localeDictionary, setLocale, getLocale, userLocale, updateLocaleFromUrl } from './locales.js';

customElements.define('sour-locale', class SourLocale extends LitElement{
	static get properties(){
		return {
			lang: String,
			localeList: Array,
			userLocale: String
		}
	}
	static get styles(){
		return css`
			:host{
				display: inline-block;
			}
		`;
	}
	constructor(){
		super();
		this.localeList = localeList;
		this.userLocale = userLocale;
		updateWhenLocaleChanges(this);
		this._localize = this._localize.bind(this);
	}
	connectedCallback(){
		super.connectedCallback();
		const lang = getLocale() || '';
		this.lang = lang;
		this._localize({detail: {readyLocale: lang}});
		self.addEventListener('lit-localize-status', this._localize);
	}
	disconnectedCallback(){
		super.disconnectedCallback();
		self.removeEventListener('lit-localize-status', this._localize);
	}
	_localize({type, detail}){
		console.log(type, {detail});
		const { readyLocale } = detail;
		document.documentElement.lang = readyLocale;
		this.lang = readyLocale;
	}
	_change(event){
		console.log(event.type, {event}, getLocale());
		setLocale(event.target.value);
	}
	render(){
		return html`
<label>
<slot></slot>
<select @change=${ this._change }>
	${ this.localeList.map(([code, label])=>{
		return html`<option ?default=${ code === this.userLocale } ?selected=${ code === this.lang } value=${ code }>${ label }</option>`;
	}) }
</select>
</label>
		`;
	}
});


