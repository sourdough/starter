import { msg, updateWhenLocaleChanges, configureLocalization } from '/wildtype/@lit/localize/lit-localize.js';

// sourceLocale is whatever the software templates have programmed in classes
const sourceLocale = '--';
const localeDictionary = {
	'en':'english',
	'ar':'عربى',
	'es':'español',
	'fr':'français',
	'he':'עִברִית',
	'jp':'日本語',
	'ko':'한국어',
	'uk':'український',
	'zh-TW':'中文', // '正體中文; 漢語, 國語',
};
const localeList = Object.entries(localeDictionary);
const defaultLocale = localeList[0][0];
let lang;
// respect user's preference, if possible: do we have a close language?
navigator.languages.find(function(code){
	if(localeDictionary[code]){
		lang = code;
		return true;
	}

	let part, i = 0, lparts = code.toLowerCase().split(/[^a-zA-Z]/);
	while(part = lparts[i++]){
		if(localeDictionary[part]){
			lang = part;
			return true;
		}
	}
});
const userLocale = lang || defaultLocale;
lang = langFromUrl();
const {getLocale, setLocale} = configureLocalization({
	sourceLocale,
	targetLocales: Object.keys(localeDictionary),
	/* TODO look into loading locales in parts, 
		is this simply the initial set of utils for this?
		load the rest in each respective module?
		look through the source....TODO */
	loadLocale: (locale) => {
		return import(`./locale.${locale}.js`);
	}
});
function langFromUrl(location=self.location){
	const url = new URL(location);
	const locale = url.searchParams.get('lang') || '';
	return localeDictionary[ locale ] ? locale : lang;
}
/*
// each locale.LL.js file does
export const templates = {
	id: html`Hola <b>Mundo</b>!`,
// other lang:
	id: html`你好, <b>世界!</b>`,
}
*/
//////////////

async function setLocaleUrl(want, ...args){
	const locale = getLocale();
	const url = new URL(location);
	const param = url.searchParams.get('lang');
	if(!localeDictionary[ want ] || (want === locale)){
		// no change
		return;
	}
	await setLocale(want);
	if(want !== param){
		if(want === userLocale){
			if(param){
			// remove param
				url.searchParams.delete('lang');
				history.pushState(history.state, self.document.title, url);
			}
		}else{
			url.searchParams.set('lang', want);
			history.pushState(history.state, self.document.title, url);
		}
	}
}

function updateLocaleFromUrl(location=self.location){
	const url = new URL(location);
	const param = url.searchParams.get('lang') || userLocale;
	if(localeDictionary[ param ] && param !== getLocale()){
		setLocale(param);
	}
}

setLocaleUrl(lang);

export { msg, updateWhenLocaleChanges, localeDictionary, localeList, getLocale, setLocaleUrl as setLocale, userLocale, updateLocaleFromUrl };
