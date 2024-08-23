/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveWindow } from 'vs/base/browser/dom';
import { Event } from 'vs/base/common/event';
import { Disposable, dispose, MutableDisposable, toDisposable } from 'vs/base/common/lifecycle';
import { TwoKeyMap } from 'vs/base/common/map';
import type { IReadableTextureAtlasPage, ITextureAtlasPageGlyph } from 'vs/editor/browser/gpu/atlas/atlas';
import { TextureAtlasPage, type AllocatorType } from 'vs/editor/browser/gpu/atlas/textureAtlasPage';
import { GlyphRasterizer } from 'vs/editor/browser/gpu/raster/glyphRasterizer';
import type { IGlyphRasterizer } from 'vs/editor/browser/gpu/raster/raster';
import { IdleTaskQueue } from 'vs/editor/browser/gpu/taskQueue';
import { MetadataConsts } from 'vs/editor/common/encodedTokenAttributes';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IThemeService } from 'vs/platform/theme/common/themeService';

export interface ITextureAtlasOptions {
	allocatorType?: AllocatorType;
}

export class TextureAtlas extends Disposable {
	private _colorMap!: string[];
	private readonly _warmUpTask: MutableDisposable<IdleTaskQueue> = this._register(new MutableDisposable());
	private readonly _warmedUpRasterizers = new Set<number>();
	private readonly _allocatorType: AllocatorType;

	/**
	 * The main texture atlas pages which are both larger textures and more efficiently packed
	 * relative to the scratch page. The idea is the main pages are drawn to and uploaded to the GPU
	 * much less frequently so as to not drop frames.
	 */
	private readonly _pages: TextureAtlasPage[] = [];
	get pages(): IReadableTextureAtlasPage[] { return this._pages; }

	readonly pageSize: number;

	/**
	 * A maps of glyph keys to the page to start searching for the glyph. This is set before
	 * searching to have as little runtime overhead (branching, intermediate variables) as possible,
	 * so it is not guaranteed to be the actual page the glyph is on. But it is guaranteed that all
	 * pages with a lower index do not contain the glyph.
	 */
	private readonly _glyphPageIndex: TwoKeyMap<string, number, number> = new TwoKeyMap();

	constructor(
		/** The maximum texture size supported by the GPU. */
		private readonly _maxTextureSize: number,
		options: ITextureAtlasOptions | undefined,
		@IThemeService private readonly _themeService: IThemeService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService
	) {
		super();

		this._allocatorType = options?.allocatorType ?? 'slab';

		this._register(Event.runAndSubscribe(this._themeService.onDidColorThemeChange, () => {
			// TODO: Clear entire atlas on theme change
			this._colorMap = this._themeService.getColorTheme().tokenColorMap;
		}));

		const dprFactor = Math.max(1, Math.floor(getActiveWindow().devicePixelRatio));

		this.pageSize = Math.min(1024 * dprFactor, this._maxTextureSize);
		const firstPage = this._instantiationService.createInstance(TextureAtlasPage, 0, this.pageSize, this._allocatorType);
		this._pages.push(firstPage);

		// IMPORTANT: The first glyph on the first page must be an empty glyph such that zeroed out
		// cells end up rendering nothing
		// TODO: This currently means the first slab is for 0x0 glyphs and is wasted
		firstPage.getGlyph(new GlyphRasterizer(1, ''), '', 0);

		this._register(toDisposable(() => dispose(this._pages)));
	}

	public getGlyph(rasterizer: IGlyphRasterizer, chars: string, metadata: number): Readonly<ITextureAtlasPageGlyph> {
		// TODO: Encode font size and family into key
		// Ignore metadata that doesn't affect the glyph
		metadata &= ~(MetadataConsts.LANGUAGEID_MASK | MetadataConsts.TOKEN_TYPE_MASK | MetadataConsts.BALANCED_BRACKETS_MASK);

		// Warm up common glyphs
		if (!this._warmedUpRasterizers.has(rasterizer.id)) {
			this._warmUpAtlas(rasterizer);
			this._warmedUpRasterizers.add(rasterizer.id);
		}

		// Try get the glyph, overflowing to a new page if necessary
		return this._tryGetGlyph(this._glyphPageIndex.get(chars, metadata) ?? 0, rasterizer, chars, metadata);
	}

	private _tryGetGlyph(pageIndex: number, rasterizer: IGlyphRasterizer, chars: string, metadata: number): Readonly<ITextureAtlasPageGlyph> {
		this._glyphPageIndex.set(chars, metadata, pageIndex);
		return (
			this._pages[pageIndex].getGlyph(rasterizer, chars, metadata)
			?? (pageIndex + 1 < this._pages.length
				? this._tryGetGlyph(pageIndex + 1, rasterizer, chars, metadata)
				: undefined)
			?? this._getGlyphFromNewPage(rasterizer, chars, metadata)
		);
	}

	private _getGlyphFromNewPage(rasterizer: IGlyphRasterizer, chars: string, metadata: number): Readonly<ITextureAtlasPageGlyph> {
		// TODO: Support more than 2 pages and the GPU texture layer limit
		this._pages.push(this._instantiationService.createInstance(TextureAtlasPage, this._pages.length, this.pageSize, this._allocatorType));
		this._glyphPageIndex.set(chars, metadata, this._pages.length - 1);
		return this._pages[this._pages.length - 1].getGlyph(rasterizer, chars, metadata)!;
	}

	public getUsagePreview(): Promise<Blob[]> {
		return Promise.all(this._pages.map(e => e.getUsagePreview()));
	}

	public getStats(): string[] {
		return this._pages.map(e => e.getStats());
	}

	/**
	 * Warms up the atlas by rasterizing all printable ASCII characters for each token color. This
	 * is distrubuted over multiple idle callbacks to avoid blocking the main thread.
	 */
	private _warmUpAtlas(rasterizer: IGlyphRasterizer): void {
		this._warmUpTask.value?.clear();
		const taskQueue = this._warmUpTask.value = new IdleTaskQueue();
		// Warm up using roughly the larger glyphs first to help optimize atlas allocation
		// A-Z
		for (let code = 65; code <= 90; code++) {
			taskQueue.enqueue(() => {
				for (const fgColor of this._colorMap.keys()) {
					this.getGlyph(rasterizer, String.fromCharCode(code), (fgColor << MetadataConsts.FOREGROUND_OFFSET) & MetadataConsts.FOREGROUND_MASK);
				}
			});
		}
		// a-z
		for (let code = 97; code <= 122; code++) {
			taskQueue.enqueue(() => {
				for (const fgColor of this._colorMap.keys()) {
					this.getGlyph(rasterizer, String.fromCharCode(code), (fgColor << MetadataConsts.FOREGROUND_OFFSET) & MetadataConsts.FOREGROUND_MASK);
				}
			});
		}
		// Remaining ascii
		for (let code = 33; code <= 126; code++) {
			taskQueue.enqueue(() => {
				for (const fgColor of this._colorMap.keys()) {
					this.getGlyph(rasterizer, String.fromCharCode(code), (fgColor << MetadataConsts.FOREGROUND_OFFSET) & MetadataConsts.FOREGROUND_MASK);
				}
			});
		}
	}
}

