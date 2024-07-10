import { ReactiveElement, LitElement, html, svg, css,
	msg, updateWhenLocaleChanges, getLocale, 
	until
	} from './deps.js';

/* use a component across several urls as an example for similar views, with localization/translation */
customElements.define('page-common', class extends LitElement{
	static get properties(){
		return {
			translation: {type: Object},
			loading: {type: Boolean},
			request: {type: Promise},
			lang: {type: String},
		}
	}
	static get styles(){
		return css`
			:host{
				display: contents;
			}
		`;
	}
	constructor(){
		super();
		updateWhenLocaleChanges(this);
		this.localize = this.localize.bind(this);
	}
	createRenderRoot() {
		return this;
	}
	localize({type, detail}){
		const lang = getLocale();
		if(lang === this.lang) return;
		this.lang = lang;
		this.loading = true;
		this.translation = html`loading`;
		this.request = import(`./locale/page.${ getLocale() }.js`).then(res=>{
			this.translation = res.templates[ location.pathname ];
			return res;
		}).catch(err=>{
			this.translation = html`<b>error</b> ${ err }`;
			return Promise.reject(err);
		})
		.finally(()=>{ this.loading = false; })
		;
	}
	connectedCallback(){
		super.connectedCallback();
		this.localize({type: 'connectedCallback-localize-init'});
		self.addEventListener('lit-localize-status', this.localize);
	}
	disconnectedCallback(){
		self.removeEventListener('lit-localize-status', this.localize);
	}
	render(){
		// replace specific to demo
		const id = location.pathname.replace('starter/www/', '');
		if(id === '/'){
			return html`page... "${ id }" ${ msg('...', {id: 'lang'}) } ${ msg('####', {id: 'demo.text.sample'}) }`;
		}else{
			return html`page... "${ id }" ${ until(this.translation, html`...loading TODO localize ${ msg('...', {id:'lang'}) } text`) }`;
		}
	}
});
