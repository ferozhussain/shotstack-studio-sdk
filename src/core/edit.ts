import { AudioPlayer } from "@canvas/players/audio-player";
import { HtmlPlayer } from "@canvas/players/html-player";
import { ImagePlayer } from "@canvas/players/image-player";
import { LumaPlayer } from "@canvas/players/luma-player";
import type { Player } from "@canvas/players/player";
import { ShapePlayer } from "@canvas/players/shape-player";
import { TextPlayer } from "@canvas/players/text-player";
import { VideoPlayer } from "@canvas/players/video-player";
import { AddClipCommand } from "@core/commands/add-clip-command";
import { AddTrackCommand } from "@core/commands/add-track-command";
import { DeleteClipCommand } from "@core/commands/delete-clip-command";
import { DeleteTrackCommand } from "@core/commands/delete-track-command";
import { SetUpdatedClipCommand } from "@core/commands/set-updated-clip-command";
import { UpdateTextContentCommand } from "@core/commands/update-text-content-command";
import { EventEmitter } from "@core/events/event-emitter";
import { Entity } from "@core/shared/entity";
import type { Size } from "@layouts/geometry";
import { AssetLoader } from "@loaders/asset-loader";
import { FontLoadParser } from "@loaders/font-load-parser";
import { ClipSchema } from "@schemas/clip";
import { EditSchema } from "@schemas/edit";
import { TrackSchema } from "@schemas/track";
import * as pixi from "pixi.js";
import { z } from "zod";

import type { EditCommand, CommandContext } from "./commands/types";

type EditType = z.infer<typeof EditSchema>;
type ClipType = z.infer<typeof ClipSchema>;
type TrackType = z.infer<typeof TrackSchema>;

export class Edit extends Entity {
	private static readonly ZIndexPadding = 100;

	public assetLoader: AssetLoader;
	public events: EventEmitter;

	private edit: EditType | null;
	private tracks: Player[][];
	private clipsToDispose: Player[];
	private clips: Player[];
	private commandHistory: EditCommand[] = [];
	private commandIndex: number = -1;

	public playbackTime: number;
	/** @internal */
	public size: Size;
	/** @internal */
	private backgroundColor: string;
	public totalDuration: number;
	/** @internal */
	public isPlaying: boolean;
	/** @internal */
	private selectedClip: Player | null;
	/** @internal */
	private updatedClip: Player | null;

	constructor(size: Size, backgroundColor: string = "#ffffff") {
		super();

		this.assetLoader = new AssetLoader();
		this.edit = null;

		this.tracks = [];
		this.clipsToDispose = [];
		this.clips = [];

		this.events = new EventEmitter();

		this.size = size;

		this.playbackTime = 0;
		this.totalDuration = 0;
		this.isPlaying = false;
		this.selectedClip = null;
		this.updatedClip = null;
		this.backgroundColor = backgroundColor;
	}

	public override async load(): Promise<void> {
		const background = new pixi.Graphics();
		background.fillStyle = {
			color: this.backgroundColor
		};

		background.rect(0, 0, this.size.width, this.size.height);
		background.fill();

		this.getContainer().addChild(background);
	}

	/** @internal */
	public override update(deltaTime: number, elapsed: number): void {
		for (const clip of this.clips) {
			if (clip.shouldDispose) {
				this.queueDisposeClip(clip);
			}

			clip.update(deltaTime, elapsed);
		}

		this.disposeClips();

		if (this.isPlaying) {
			this.playbackTime = Math.max(0, Math.min(this.playbackTime + elapsed, this.totalDuration));

			if (this.playbackTime === this.totalDuration) {
				this.pause();
			}
		}
	}
	/** @internal */
	public override draw(): void {
		for (const clip of this.clips) {
			clip.draw();
		}
	}
	/** @internal */
	public override dispose(): void {
		this.clearClips();
	}

	public play(): void {
		this.isPlaying = true;
	}
	public pause(): void {
		this.isPlaying = false;
	}
	public seek(target: number): void {
		this.playbackTime = Math.max(0, Math.min(target, this.totalDuration));
		this.pause();
	}
	public stop(): void {
		this.seek(0);
	}

	public async loadEdit(edit: EditType): Promise<void> {
		this.clearClips();

		this.edit = EditSchema.parse(edit);

		this.backgroundColor = this.edit.timeline.background || "#000000";

		await Promise.all(
			(this.edit.timeline.fonts ?? []).map(async font => {
				const identifier = font.src;
				const loadOptions: pixi.UnresolvedAsset = { src: identifier, loadParser: FontLoadParser.Name };

				return this.assetLoader.load<FontFace>(identifier, loadOptions);
			})
		);

		for (const [trackIdx, track] of this.edit.timeline.tracks.entries()) {
			for (const clip of track.clips) {
				const clipPlayer = this.createPlayerFromAssetType(clip);
				clipPlayer.layer = trackIdx + 1;
				await this.addPlayer(trackIdx, clipPlayer);
			}
		}

		this.updateTotalDuration();
	}
	public getEdit(): EditType {
		const tracks: TrackType[] = [];
		const trackMap = new Map<number, TrackType>();

		for (const clip of this.clips) {
			if (!trackMap.has(clip.layer)) {
				trackMap.set(clip.layer, { clips: [] });
			}
			trackMap.get(clip.layer)!.clips.push(clip.clipConfiguration);
		}

		const maxTrack = Math.max(...trackMap.keys(), 0);
		for (let i = 1; i <= maxTrack; i += 1) {
			tracks[i - 1] = trackMap.get(i) || { clips: [] };
		}

		return {
			timeline: {
				background: this.backgroundColor,
				tracks,
				fonts: this.edit?.timeline.fonts || []
			},
			output: this.edit?.output || { size: this.size, format: "mp4" }
		};
	}

	public addClip(trackIdx: number, clip: ClipType): void {
		const command = new AddClipCommand(trackIdx, clip);
		this.executeCommand(command);
	}
	public getClip(trackIdx: number, clipIdx: number): ClipType | null {
		const clipsByTrack = this.clips.filter((clip: Player) => clip.layer === trackIdx + 1);
		if (clipIdx < 0 || clipIdx >= clipsByTrack.length) return null;

		return clipsByTrack[clipIdx].clipConfiguration;
	}
	public deleteClip(trackIdx: number, clipIdx: number): void {
		const command = new DeleteClipCommand(trackIdx, clipIdx);
		this.executeCommand(command);
	}

	public addTrack(trackIdx: number, track: TrackType): void {
		const command = new AddTrackCommand(trackIdx);
		this.executeCommand(command);
		track?.clips?.forEach(clip => this.addClip(trackIdx, clip));
	}
	public getTrack(trackIdx: number): TrackType | null {
		const trackClips = this.clips.filter((clip: Player) => clip.layer === trackIdx + 1);
		if (trackClips.length === 0) return null;

		return {
			clips: trackClips.map((clip: Player) => clip.clipConfiguration)
		};
	}
	public deleteTrack(trackIdx: number): void {
		const command = new DeleteTrackCommand(trackIdx);
		this.executeCommand(command);
	}

	public getTotalDuration(): number {
		return this.totalDuration;
	}

	public undo(): void {
		if (this.commandIndex >= 0) {
			const command = this.commandHistory[this.commandIndex];
			if (command.undo) {
				const context = this.createCommandContext();
				command.undo(context);
				this.commandIndex -= 1;
				this.events.emit("edit:undo", { command: command.name });
			}
		}
	}

	public redo(): void {
		if (this.commandIndex < this.commandHistory.length - 1) {
			this.commandIndex += 1;
			const command = this.commandHistory[this.commandIndex];
			const context = this.createCommandContext();
			command.execute(context);
			this.events.emit("edit:redo", { command: command.name });
		}
	}
	/** @internal */
	public getSelectedClip(): Player | null {
		return this.selectedClip;
	}
	/** @internal */
	public setSelectedClip(clip: Player): void {
		this.selectedClip = clip;

		const trackIndex = clip.layer - 1;
		const clipsByTrack = this.clips.filter((clipItem: Player) => clipItem.layer === clip.layer);
		const clipIndex = clipsByTrack.indexOf(clip);

		const eventData = {
			clip: clip.clipConfiguration,
			trackIndex,
			clipIndex
		};

		this.events.emit("clip:selected", eventData);
	}
	/** @internal */
	public setUpdatedClip(clip: Player, initialClipConfig: ClipType | null = null, finalClipConfig: ClipType | null = null): void {
		const command = new SetUpdatedClipCommand(clip, initialClipConfig, finalClipConfig);
		this.executeCommand(command);
	}
	/** @internal */
	public updateTextContent(clip: Player, newText: string, initialConfig: ClipType): void {
		const command = new UpdateTextContentCommand(clip, newText, initialConfig);
		this.executeCommand(command);
	}

	private executeCommand(command: EditCommand): void | Promise<void> {
		const context = this.createCommandContext();
		const result = command.execute(context);
		this.commandHistory = this.commandHistory.slice(0, this.commandIndex + 1);
		this.commandHistory.push(command);
		this.commandIndex += 1;
		return result;
	}

	private createCommandContext(): CommandContext {
		return {
			getClips: () => [...this.clips],
			getTracks: () => this.tracks,
			getContainer: () => this.getContainer(),
			addPlayer: (trackIdx, player) => this.addPlayer(trackIdx, player),
			createPlayerFromAssetType: clipConfiguration => this.createPlayerFromAssetType(clipConfiguration),
			queueDisposeClip: player => this.queueDisposeClip(player),
			disposeClips: () => this.disposeClips(),
			undeleteClip: (_trackIdx, clip) => {
				this.clips.push(clip);
				this.updateTotalDuration();
			},
			setUpdatedClip: clip => {
				this.updatedClip = clip;
			},
			restoreClipConfiguration: (clip, previousConfig) => {
				Object.assign(clip.clipConfiguration, structuredClone(previousConfig));
				clip.reconfigureAfterRestore();
				clip.draw();
			},
			updateDuration: () => this.updateTotalDuration(),
			emitEvent: (name, data) => this.events.emit(name, data)
		};
	}

	private queueDisposeClip(clipToDispose: Player): void {
		this.clipsToDispose.push(clipToDispose);
	}
	protected disposeClips(): void {
		if (this.clipsToDispose.length === 0) {
			return;
		}

		for (const clip of this.clipsToDispose) {
			this.disposeClip(clip);
		}

		this.clips = this.clips.filter((clip: Player) => !this.clipsToDispose.includes(clip));
		this.clipsToDispose = [];
		this.updateTotalDuration();
	}
	private disposeClip(clip: Player): void {
		try {
			if (this.getContainer().children.includes(clip.getContainer())) {
				const childIndex = this.getContainer().getChildIndex(clip.getContainer());
				this.getContainer().removeChildAt(childIndex);
			} else {
				for (const child of this.getContainer().children) {
					if (child instanceof pixi.Container && child.label?.toString().startsWith("shotstack-track-")) {
						if (child.children.includes(clip.getContainer())) {
							child.removeChild(clip.getContainer());
							break;
						}
					}
				}
			}
		} catch (error) {
			console.warn("Attempting to unmount an unmounted clip.");
		}

		this.unloadClipAssets(clip);
		clip.dispose();
	}
	private unloadClipAssets(clip: Player): void {
		const { asset } = clip.clipConfiguration;
		if (asset && "src" in asset && typeof asset.src === "string") {
			try {
				pixi.Assets.unload(asset.src);
			} catch (error) {
				console.warn(`Failed to unload asset: ${asset.src}`, error);
			}
		}
	}
	protected clearClips(): void {
		for (const clip of this.clips) {
			this.disposeClip(clip);
		}

		this.clips = [];

		this.clipsToDispose = [];

		this.updateTotalDuration();
	}
	private updateTotalDuration(): void {
		let maxDuration = 0;

		for (const track of this.tracks) {
			for (const clip of track) {
				maxDuration = Math.max(maxDuration, clip.getEnd());
			}
		}

		this.totalDuration = maxDuration;
	}
	private createPlayerFromAssetType(clipConfiguration: ClipType): Player {
		if (!clipConfiguration.asset?.type) {
			throw new Error("Invalid clip configuration: missing asset type");
		}

		let player: Player;

		switch (clipConfiguration.asset.type) {
			case "text": {
				player = new TextPlayer(this, clipConfiguration);
				break;
			}
			case "shape": {
				player = new ShapePlayer(this, clipConfiguration);
				break;
			}
			case "html": {
				player = new HtmlPlayer(this, clipConfiguration);
				break;
			}
			case "image": {
				player = new ImagePlayer(this, clipConfiguration);
				break;
			}
			case "video": {
				player = new VideoPlayer(this, clipConfiguration);
				break;
			}
			case "audio": {
				player = new AudioPlayer(this, clipConfiguration);
				break;
			}
			case "luma": {
				player = new LumaPlayer(this, clipConfiguration);
				break;
			}
			default:
				throw new Error(`Unsupported clip type: ${(clipConfiguration.asset as any).type}`);
		}

		return player;
	}
	private async addPlayer(trackIdx: number, clipToAdd: Player): Promise<void> {
		while (this.tracks.length <= trackIdx) {
			this.tracks.push([]);
		}

		this.tracks[trackIdx].push(clipToAdd);

		this.clips.push(clipToAdd);

		const zIndex = 100000 - (trackIdx + 1) * Edit.ZIndexPadding;

		const trackContainerKey = `shotstack-track-${zIndex}`;
		let trackContainer = this.getContainer().getChildByLabel(trackContainerKey, false);

		if (!trackContainer) {
			trackContainer = new pixi.Container({ label: trackContainerKey, zIndex });
			this.getContainer().addChild(trackContainer);
		}

		trackContainer.addChild(clipToAdd.getContainer());

		const isClipMask = clipToAdd instanceof LumaPlayer;

		await clipToAdd.load();

		if (isClipMask) {
			trackContainer.setMask({ mask: clipToAdd.getMask(), inverse: true });
		}

		this.updateTotalDuration();
	}
}
